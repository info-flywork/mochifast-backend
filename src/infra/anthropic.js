import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../shared/errors.js';
import { createBreaker } from './breaker.js';

/**
 * Claude API istemcisi (docs/backend/09-yapay-zeka.md). Tüm çağrılar buradan geçer:
 * - sunucu tarafı yedek model: `fallbacks: "default"` + `server-side-fallback-2026-07-01`
 * - devre kesici: art arda geçici hatalarda kısa süre hızlı başarısızlık (maliyet + kuyruk koruması)
 * - hatalar SDK'nın tipli sınıflarıyla sınıflandırılır (mesaj metni eşleştirilmez)
 */

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * @returns 'aborted' | 'timeout' | 'connection' | 'rate_limited' | 'overloaded' | 'permanent'
 * Geçici olanlar (connection, timeout, rate_limited, overloaded) yeniden denenebilir.
 */
export function classifyAiError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return 'aborted';
  // Zaman aşımı, bağlantı hatasının alt sınıfıdır: önce kontrol edilir.
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof Anthropic.APIConnectionError) return 'connection';
  if (err instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (err instanceof Anthropic.InternalServerError) return 'overloaded';
  if (err instanceof Anthropic.APIError && Number(err.status) >= 500) return 'overloaded';
  return 'permanent';
}

export const isTransient = (kind) =>
  ['timeout', 'connection', 'rate_limited', 'overloaded'].includes(kind);

/**
 * Token × fiyat (USD / milyon token) → mikro-USD. Fiyatlar `app_config.ai.pricing`'ten gelir
 * (kodda değil; değişebilir). Model fiyatı yoksa 0 (maliyet raporunda eksik görünür, çağrı engellenmez).
 */
export function costMicroUsd(usage, price) {
  if (!usage || !price) return 0;
  return Math.round(
    (usage.input_tokens ?? 0) * (price.inputPerMTok ?? 0) +
      (usage.output_tokens ?? 0) * (price.outputPerMTok ?? 0) +
      (usage.cache_read_input_tokens ?? 0) * (price.cacheReadPerMTok ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) * (price.cacheWritePerMTok ?? 0),
  );
}

/**
 * @param config config.ai
 * @param deps.clientImpl testte sahte istemci (`beta.messages.create/stream`)
 */
export function createAiClient(config, { logger, clientImpl, now = Date.now } = {}) {
  const client =
    clientImpl ?? (config.enabled ? new Anthropic({ apiKey: config.apiKey, maxRetries: 2 }) : null);
  const breaker = createBreaker({
    name: 'ai',
    isTransient: (err) => isTransient(classifyAiError(err)),
    now,
    logger,
  });

  function guard() {
    if (!client) throw new AppError('UNAVAILABLE', { details: { reason: 'ai_disabled' } });
    breaker.guard();
  }

  const record = (err) => (err ? breaker.failure(err) : breaker.success());

  /** Ortak parametreler: yedek model yalnızca açıksa (kapatılabilir, 09 §1). */
  function withDefaults(params) {
    if (!config.serverFallback) return params;
    return { ...params, betas: [...(params.betas ?? []), FALLBACK_BETA], fallbacks: 'default' };
  }

  return {
    enabled: Boolean(client),

    /** Tek çağrı (ör. fotoğraf analizi). `refusal` kontrolü çağıranındır. */
    async create(params, { timeoutMs, signal } = {}) {
      guard();
      try {
        const message = await client.beta.messages.create(withDefaults(params), {
          timeout: timeoutMs,
          signal,
        });
        record();
        return message;
      } catch (err) {
        record(err);
        throw err;
      }
    },

    /** Akış (sohbet). Dönen nesne SDK'nın MessageStream'idir. */
    stream(params, { timeoutMs, signal } = {}) {
      guard();
      const stream = client.beta.messages.stream(withDefaults(params), {
        timeout: timeoutMs,
        signal,
      });
      stream.finalMessage().then(
        () => record(),
        (err) => record(err),
      );
      return stream;
    },
  };
}
