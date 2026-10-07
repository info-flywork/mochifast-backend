import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { aiJobs } from '../../src/jobs/ai.jobs.js';
import { toBin } from '../../src/shared/ids.js';
import { aiMessage, createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const silent = { info() {}, warn() {}, error() {} };

const MEAL = {
  isFood: true,
  mealTitle: 'Mercimek çorbası ve ekmek',
  items: [
    { name: 'Mercimek çorbası', portion: '1 kase', kcal: 230, proteinG: 12, carbsG: 32, fatG: 6 },
    { name: 'Ekmek', portion: '1 dilim', kcal: 80, proteinG: 3, carbsG: 15, fatG: 1 },
  ],
  kcal: 310,
  proteinG: 15,
  carbsG: 47,
  fatG: 7,
  confidence: 0.7,
  notes: 'Tereyağı miktarı belirsiz',
};

function multipart(buffer) {
  const boundary = `----mochi${randomUUID()}`;
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="m.jpg"\r\n` +
          'Content-Type: image/jpeg\r\n\r\n',
      ),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

let shade = 0;
/** Her çağrıda farklı içerik (yinelenen yükleme tespitine takılmasın). */
const photo = () =>
  sharp({
    create: { width: 1200, height: 900, channels: 3, background: { r: 120, g: 80, b: shade++ } },
  })
    .jpeg()
    .toBuffer();

describe.skipIf(!mysqlUrl)('fotoğraftan öğün analizi (gerçek MySQL, sahte Claude)', () => {
  let ctx;
  let jobs;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    jobs = aiJobs({
      db: ctx.db,
      storage: ctx.storage,
      config: ctx.config,
      logger: silent,
      ai: ctx.ai,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function newUser({ consent = true } = {}) {
    const { token, user } = (await ctx.guest(randomUUID())).json().data;
    if (consent) {
      await ctx.call('POST', '/user/consents', {
        token: token.accessToken,
        body: { type: 'aiProcessing', version: '2026-10', granted: true },
      });
    }
    return { token: token.accessToken, userId: user.id };
  }

  async function submit(token, buffer) {
    const { payload, headers } = multipart(buffer ?? (await photo()));
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/meals/photo-analyses',
      payload,
      headers: { ...headers, authorization: `Bearer ${token}`, 'accept-language': 'tr' },
    });
  }

  /** Kuyruktaki işi worker gibi çalıştırır. */
  async function runJob(analysisId, { attempt = 1, maxAttempts = 3 } = {}) {
    await jobs.photoAnalysis({ payload: { analysisId }, attempt, maxAttempts });
  }

  const getAnalysis = async (token, id) =>
    (await ctx.call('GET', `/meals/photo-analyses/${id}`, { token })).json().data.analysis;
  const quota = async (token) =>
    (await ctx.call('GET', '/chat/quota', { token })).json().data.photoAnalysis;

  it('rıza yoksa 403 CONSENT_REQUIRED (fotoğraf gönderilmez)', async () => {
    const { token } = await newUser({ consent: false });
    const res = await submit(token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      code: 'CONSENT_REQUIRED',
      details: { consent: 'aiProcessing' },
    });
    expect(ctx.anthropic.calls).toHaveLength(0);
  });

  it('gönder → 202 → işle → sonuç; istek biçimi; kullanım ve maliyet kaydı; öğüne bağla', async () => {
    const { token, userId } = await newUser();
    ctx.anthropic.respond(() => aiMessage(MEAL));
    const res = await submit(token);
    expect(res.statusCode).toBe(202);
    const { analysisId, status, pollAfterMs } = res.json().data;
    expect({ status, pollAfterMs }).toEqual({ status: 'queued', pollAfterMs: 1500 });
    expect((await getAnalysis(token, analysisId)).status).toBe('queued');

    const queued = await ctx.db.one(
      "SELECT payload FROM jobs WHERE queue = 'ai' AND name = 'photoAnalysis' ORDER BY id DESC LIMIT 1",
    );
    const payload =
      typeof queued.payload === 'string' ? JSON.parse(queued.payload) : queued.payload;
    expect(payload.analysisId).toBe(analysisId);

    // Bu kullanıcının cevaplanmış rıza isteği sonrasına bakılır.
    const before = ctx.anthropic.calls.length;
    await runJob(analysisId);
    const request = ctx.anthropic.calls[before];
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    const [image, instruction] = request.messages[0].content;
    expect(image.source).toMatchObject({ type: 'base64', media_type: 'image/webp' });
    expect((await sharp(Buffer.from(image.source.data, 'base64')).metadata()).width).toBe(1200);
    expect(instruction.text).toContain('Language: Turkish');

    const done = await getAnalysis(token, analysisId);
    expect(done).toMatchObject({
      status: 'succeeded',
      result: { mealTitle: 'Mercimek çorbası ve ekmek', kcal: 310, confidence: 0.7, flags: [] },
      error: null,
    });
    expect(done.photo.url).toContain('_1024.webp?token=');

    const usage = await ctx.db.one(
      `SELECT requests, input_tokens, cost_micro_usd FROM ai_usage_daily
        WHERE user_id = :id AND feature = 'photo_analysis'`,
      { id: toBin(userId) },
    );
    // 1500 × $4 + 400 × $20 (MTok başına) = 14 000 µUSD
    expect(usage).toMatchObject({ requests: 1, input_tokens: 1500, cost_micro_usd: 14000 });

    const meal = await ctx.call('POST', '/meals', {
      token,
      body: { analysisId, title: done.result.mealTitle, kcal: 290, proteinG: 15 },
    });
    expect(meal.statusCode).toBe(201);
    expect(meal.json().data.meal).toMatchObject({ source: 'aiPhoto', kcal: 290 });
    expect(meal.json().data.meal.photo.id).toBe(done.photo.id);

    // Başkası ne görür ne bağlar.
    const other = await newUser();
    expect(
      (await ctx.call('GET', `/meals/photo-analyses/${analysisId}`, { token: other.token }))
        .statusCode,
    ).toBe(404);
  });

  it('kabul kriteri: ücretsiz kullanıcı günde 2 analiz; 3. → 429 (resetAt); aynı fotoğraf yeni hak düşmez', async () => {
    const { token } = await newUser();
    ctx.anthropic.respond(() => aiMessage(MEAL));
    const img = await photo();
    const first = (await submit(token, img)).json().data.analysisId;
    const again = await submit(token, img);
    expect(again.statusCode).toBe(202);
    expect(again.json().data.analysisId).toBe(first);
    expect((await quota(token)).used).toBe(1);

    expect((await submit(token)).statusCode).toBe(202);
    const third = await submit(token);
    expect(third.statusCode).toBe(429);
    const { details } = third.json().error;
    expect(details).toMatchObject({
      kind: 'photoAnalysis',
      limit: 2,
      used: 2,
      upgradeAvailable: true,
    });
    expect(new Date(details.resetAt).getTime()).toBeGreaterThan(Date.now());
    expect(await quota(token)).toMatchObject({ used: 2, limit: 2, remaining: 0 });
  });

  it('ret (refusal) → failed REFUSED, hak iade; yemek değil → notFood, hak düşer', async () => {
    const { token } = await newUser();
    ctx.anthropic.respond(() => aiMessage('', { stopReason: 'refusal' }));
    const refused = (await submit(token)).json().data.analysisId;
    await runJob(refused);
    expect(await getAnalysis(token, refused)).toMatchObject({
      status: 'failed',
      error: { code: 'REFUSED' },
    });
    expect((await quota(token)).used).toBe(0);

    ctx.anthropic.respond(() => aiMessage({ ...MEAL, isFood: false, items: [] }));
    const notFood = (await submit(token)).json().data.analysisId;
    await runJob(notFood);
    expect(await getAnalysis(token, notFood)).toMatchObject({ status: 'notFood', result: null });
    expect((await quota(token)).used).toBe(1);
  });

  it('geçici hata: son deneme değilse yeniden denenir; son denemede failed + iade; geçersiz çıktı', async () => {
    const { token } = await newUser();
    ctx.anthropic.respond(() => {
      throw Object.create(Anthropic.RateLimitError.prototype);
    });
    const id = (await submit(token)).json().data.analysisId;
    await expect(runJob(id, { attempt: 1, maxAttempts: 3 })).rejects.toBeTruthy();
    expect((await getAnalysis(token, id)).status).toBe('processing');
    await runJob(id, { attempt: 3, maxAttempts: 3 });
    expect(await getAnalysis(token, id)).toMatchObject({
      status: 'failed',
      error: { code: 'AI_UNAVAILABLE' },
    });
    expect((await quota(token)).used).toBe(0);

    ctx.anthropic.respond(() => aiMessage('not json {'));
    const bad = (await submit(token)).json().data.analysisId;
    await runJob(bad);
    expect((await getAnalysis(token, bad)).error).toEqual({ code: 'INVALID_OUTPUT' });

    // Başarısız analiz öğüne bağlanamaz.
    const res = await ctx.call('POST', '/meals', { token, body: { analysisId: bad, kcal: 1 } });
    expect(res.statusCode).toBe(409);
  });
});
