import { readFileSync } from 'node:fs';
import { classifyOpenAiError } from '../../infra/openai.js';
import { AppError, isAppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import * as repo from './photo-analysis.repository.js';
import {
  ANALYSIS_SCHEMA,
  PROMPT_VERSION,
  languageName,
  normalizeAnalysis,
} from './meal-analysis.rules.js';

const PROMPT = readFileSync(
  new URL(`../../../prompts/${PROMPT_VERSION}.md`, import.meta.url),
  'utf8',
);
const MAX_TOKENS = 8000;
export const POLL_AFTER_MS = 1500;
export const ANALYSIS_MAX_ATTEMPTS = 3;

const STATUS_API = { not_food: 'notFood' };
const TRANSIENT = new Set(['timeout', 'connection', 'rate_limited', 'overloaded']);

/** OpenAI isteği (servis ve eval betiği aynısını kullanır: ölçülen = üretimde çalışan). */
export function analysisRequest(image, locale, config) {
  return {
    model: config.visionModel,
    max_tokens: MAX_TOKENS,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'meal_analysis',
        strict: true,
        schema: ANALYSIS_SCHEMA,
      },
    },
    messages: [
      { role: 'system', content: PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/webp;base64,${image.toString('base64')}`,
              detail: 'high',
            },
          },
          {
            type: 'text',
            text: `Language: ${languageName(locale)}. Estimate the nutrition of this meal.`,
          },
        ],
      },
    ],
  };
}

/** OpenAI yanıtı → {status, result} ya da {status:'failed', errorCode}. */
export function interpret(message) {
  if (message.refusal || message.finishReason === 'content_filter') {
    return { status: 'failed', errorCode: 'REFUSED' };
  }
  if (message.finishReason === 'length') return { status: 'failed', errorCode: 'TRUNCATED' };
  try {
    const n = normalizeAnalysis(JSON.parse(message.text));
    return { status: n.isFood ? 'succeeded' : 'not_food', result: n.result };
  } catch {
    return { status: 'failed', errorCode: 'INVALID_OUTPUT' };
  }
}

/**
 * Fotoğraftan öğün analizi (docs/backend/09-yapay-zeka.md §3). API: rıza → bütçe → kota →
 * yükle → kuyruk, 202. Worker: OpenAI çağrısı → ret/biçim kontrolü → sunucu tarafı doğrulama.
 * Başarısız analizde kota iade edilir; "yemek değil" sonucu hak düşer (AI maliyeti oluştu).
 */
export function createPhotoAnalysisService({ db, jobs, gate, media, ai, storage, config, logger }) {
  function toDto(a, photo) {
    return {
      id: a.id,
      status: STATUS_API[a.status] ?? a.status,
      photo: photo ?? null,
      result: a.status === 'succeeded' ? a.result : null,
      error: a.status === 'failed' ? { code: a.errorCode } : null,
      createdAt: a.createdAt.toISOString(),
      completedAt: a.completedAt ? a.completedAt.toISOString() : null,
    };
  }

  async function fail(a, errorCode, extra = {}) {
    await repo.complete(db, a.id, { status: 'failed', errorCode, ...extra });
    await gate.refund(a.userId, 'photo_analysis', a.quotaDate);
  }

  const service = {
    /** POST /v1/meals/photo-analyses */
    async submit(userId, buffer, locale) {
      if (!ai.enabled) throw new AppError('UNAVAILABLE', { details: { reason: 'ai_disabled' } });
      await gate.assertConsent(userId);
      const isPremium = await gate.isPremium(userId);
      const quota = await gate.consume(userId, 'photo_analysis', { isPremium });
      try {
        const { media: photo } = await media.upload(userId, 'meal_photo', buffer);
        // Aynı fotoğraf tekrar gönderildi: yeni AI çağrısı yapılmaz, hak iade edilir.
        const previous = await repo.findByMedia(db, userId, photo.id);
        if (previous) {
          await gate.refund(userId, 'photo_analysis', quota.localDate);
          return {
            analysisId: previous.id,
            status: toDto(previous).status,
            pollAfterMs: POLL_AFTER_MS,
          };
        }
        const id = newId();
        await db.withTransaction(async (conn) => {
          await repo.insertAnalysis(
            db,
            { id, userId, mediaId: photo.id, locale, quotaDate: quota.localDate },
            conn,
          );
          await jobs.enqueue(
            'ai',
            'photoAnalysis',
            { analysisId: id },
            { conn, maxAttempts: ANALYSIS_MAX_ATTEMPTS, dedupeKey: `photo:${id}` },
          );
        });
        return { analysisId: id, status: 'queued', pollAfterMs: POLL_AFTER_MS };
      } catch (err) {
        await gate.refund(userId, 'photo_analysis', quota.localDate);
        throw err;
      }
    },

    /** GET /v1/meals/photo-analyses/:id — yalnızca sahibine. */
    async get(userId, id) {
      const a = await repo.findAnalysis(db, id);
      if (!a || a.userId !== userId) throw new AppError('NOT_FOUND');
      const [photo] = (await media.presentMany([a.mediaId])).values();
      return { analysis: toDto(a, photo) };
    },

    /** Öğün kaydında kullanılabilir mi (kendi, başarılı analiz)? */
    async mustUse(userId, id) {
      const a = await repo.findAnalysis(db, id);
      if (!a || a.userId !== userId) throw new AppError('NOT_FOUND');
      if (a.status !== 'succeeded') {
        throw new AppError('CONFLICT', {
          details: { reason: 'analysis_not_ready', status: a.status },
        });
      }
      return a;
    },

    /**
     * Worker işi. Geçici hatada (429/5xx/zaman aşımı/devre açık) son deneme değilse hata fırlatılır
     * ve kuyruk geri çekilmeyle yeniden dener; son denemede ya da kalıcı hatada kayıt `failed` olur.
     */
    async run(analysisId, { attempt = 1, maxAttempts = 1 } = {}) {
      const a = await repo.findAnalysis(db, analysisId);
      if (!a || !(await repo.markProcessing(db, analysisId))) return;
      const photo = await media.mustOwn(a.userId, a.mediaId).catch(() => null);
      if (!photo) return fail(a, 'PHOTO_MISSING');
      const image = await storage.private.get(photo.variants.lg ?? photo.variants.md);

      const started = Date.now();
      let message;
      try {
        message = await ai.create(analysisRequest(image, a.locale, config), {
          timeoutMs: config.analysisTimeoutMs,
        });
      } catch (err) {
        const kind = isAppError(err) ? 'unavailable' : classifyOpenAiError(err);
        const retry = (kind === 'unavailable' || TRANSIENT.has(kind)) && attempt < maxAttempts;
        logger?.warn({ analysisId, kind, attempt, retry }, 'fotoğraf analizi çağrısı başarısız');
        if (retry) throw err;
        return fail(a, kind === 'permanent' ? 'AI_ERROR' : 'AI_UNAVAILABLE');
      }

      const latencyMs = Date.now() - started;
      await gate.recordUsage(a.userId, 'photo_analysis', message);
      const meta = {
        model: message.model,
        promptVersion: PROMPT_VERSION,
        inputTokens: message.usage?.input_tokens,
        outputTokens: message.usage?.output_tokens,
        latencyMs,
      };
      const outcome = interpret(message);
      if (outcome.status === 'failed') {
        if (outcome.errorCode === 'INVALID_OUTPUT')
          logger?.error({ analysisId }, 'analiz çıktısı geçersiz');
        return fail(a, outcome.errorCode, meta);
      }
      await repo.complete(db, analysisId, { ...outcome, ...meta });
    },
  };
  return service;
}
