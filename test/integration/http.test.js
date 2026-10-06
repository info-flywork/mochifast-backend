import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { AppError } from '../../src/shared/errors.js';
import { envelope } from '../../src/shared/schemas.js';
import { fakeDeps, fakeRedis } from '../helpers/fakes.js';
import { testConfig } from '../helpers/infra.js';

const apps = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/**
 * Altyapısız uygulama + test route'ları.
 */
async function makeApp({ env = {}, deps = fakeDeps() } = {}) {
  const app = await buildApp({
    config: testConfig(env),
    logger: false,
    deps,
    registerV1: async (v1) => {
      v1.post(
        '/_test/echo',
        {
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['weightKg'],
              properties: { weightKg: { type: 'number', minimum: 25, maximum: 350 } },
            },
            response: {
              200: envelope({
                type: 'object',
                properties: { weightKg: { type: 'number' } },
              }),
            },
          },
        },
        // `secret` yanıt şemasında yok → serileştirilmemeli (sızıntı koruması)
        async (request) => ({ ...request.body, secret: 'sızmamalı' }),
      );
      v1.get('/_test/ctx', async (request) => request.ctx);
      v1.get('/_test/conflict', async () => {
        throw new AppError('ACTIVE_FAST_EXISTS', {
          details: { activeFastId: 'abc' },
          headers: { 'x-custom': '1' },
        });
      });
      v1.get('/_test/boom', async () => {
        throw new Error('db şifresi: hunter2');
      });
    },
  });
  apps.push(app);
  await app.ready();
  return app;
}

describe('yanıt zarfı & başlıklar', () => {
  it('başarılı yanıt { status, message, data } ile sarılır', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'success', message: 'OK', data: { status: 'ok' } });
    expect(typeof body.data.uptimeSec).toBe('number');
  });

  it('güvenlik başlıkları ve varsayılan no-store', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('yanıt şeması tanımsız alanları ATAR (sızıntı koruması)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      payload: { weightKg: 74.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'success', message: 'OK', data: { weightKg: 74.5 } });
    expect(res.body).not.toContain('sızmamalı');
  });

  it('message Accept-Language diline göre', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      headers: { 'accept-language': 'tr-TR,tr;q=0.9' },
      payload: { weightKg: 70 },
    });
    expect(res.json().message).toBe('Tamam');
  });
});

describe('request id', () => {
  it('geçerli istemci X-Request-Id korunur, geçersiz olan değiştirilir', async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'abc-12345678' },
    });
    expect(ok.headers['x-request-id']).toBe('abc-12345678');
    const bad = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'x\n{"evil":1}' },
    });
    expect(bad.headers['x-request-id']).not.toContain('evil');
  });
});

describe('hata zarfı', () => {
  it('bilinmeyen route → 404 NOT_FOUND, yerelleştirilmiş', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/yok',
      headers: { 'accept-language': 'tr' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.status).toBe('error');
    expect(body.message).toBe('Aradığın şeyi bulamadık.');
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('şema ihlali → 400 VALIDATION_FAILED + alan ayrıntıları', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      payload: { weightKg: 500 },
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details.fields[0]).toMatchObject({ path: 'body.weightKg', keyword: 'maximum' });
  });

  it('bilinmeyen alan → 400 (additionalProperties: false)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      payload: { weightKg: 70, isPremium: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.fields[0].path).toBe('body.isPremium');
  });

  it('AppError → doğru durum, kod, details ve header', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/_test/conflict' });
    expect(res.statusCode).toBe(409);
    expect(res.headers['x-custom']).toBe('1');
    expect(res.json().error).toMatchObject({
      code: 'ACTIVE_FAST_EXISTS',
      details: { activeFastId: 'abc' },
    });
  });

  it('beklenmeyen hata → 500 INTERNAL, iç ayrıntı SIZDIRILMAZ', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/_test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('stack');
  });

  it('bozuk JSON → 400 INVALID_JSON', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"weightKg": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_JSON');
  });

  it('gövde limiti → 413 PAYLOAD_TOO_LARGE', async () => {
    const app = await makeApp({ env: { BODY_LIMIT_BYTES: '1024' } });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      payload: { weightKg: 70, pad: 'x'.repeat(5000) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('desteklenmeyen içerik türü → 415', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/_test/echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('istek bağlamı (request.ctx)', () => {
  it("geçerli header'lar ayrıştırılır", async () => {
    const app = await makeApp();
    const installId = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
    const res = await app.inject({
      method: 'GET',
      url: '/v1/_test/ctx',
      headers: {
        'accept-language': 'de',
        'x-timezone': 'Europe/Istanbul',
        'x-app-version': '1.2.3',
        'x-platform': 'iOS',
        'x-install-id': installId,
      },
    });
    expect(res.json().data).toMatchObject({
      locale: 'de',
      timezone: 'Europe/Istanbul',
      appVersion: '1.2.3',
      platform: 'ios',
      installId,
    });
  });

  it("geçersiz header'lar null olur, istek reddedilmez", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/_test/ctx',
      headers: {
        'x-timezone': 'Mars/Base',
        'x-app-version': '1.0; DROP',
        'x-platform': 'web',
        'x-install-id': 'nope',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      locale: 'en',
      timezone: null,
      appVersion: null,
      platform: null,
      installId: null,
    });
  });
});

describe('rate limit', () => {
  it('limit aşımında 429 RATE_LIMITED + Retry-After; sağlık uçları muaf', async () => {
    const app = await makeApp({ env: { RATE_LIMIT_GLOBAL_MAX: '3' } });
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/v1/_test/ctx' })).statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'GET', url: '/v1/_test/ctx' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    for (let i = 0; i < 10; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    }
  });
});

describe('readiness', () => {
  it('tüm bağımlılıklar ayaktaysa 200', async () => {
    const deps = { ...fakeDeps(), cacheRedis: fakeRedis() };
    const app = await makeApp({ deps });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.checks).toMatchObject({
      mysql: { status: 'up' },
      redisCache: { status: 'up' },
      redisQueue: { status: 'up' },
    });
  });

  it('bir bağımlılık düşükse 503 UNAVAILABLE; iç hata mesajı sızmaz', async () => {
    const deps = { ...fakeDeps({ dbUp: false }), cacheRedis: fakeRedis() };
    const app = await makeApp({ deps });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.code).toBe('UNAVAILABLE');
    expect(body.error.details.checks.mysql.status).toBe('down');
    expect(res.body).not.toContain('db down');
  });

  it('kapanış sırasında 503 (LB trafiği keser)', async () => {
    const deps = { ...fakeDeps(), cacheRedis: fakeRedis() };
    const app = await makeApp({ deps });
    app.isShuttingDown = true;
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.details.reason).toBe('shutting_down');
  });
});

describe('CORS', () => {
  it("varsayılan: hiçbir origin'e izin yok", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it("yalnızca yapılandırılmış yönetim paneli origin'i", async () => {
    const app = await makeApp({ env: { CORS_ORIGINS: 'https://admin.mochifast.app' } });
    const ok = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://admin.mochifast.app' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('https://admin.mochifast.app');
    const no = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://evil.example' },
    });
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('OpenAPI & belgeler', () => {
  it('şemalardan OpenAPI üretilir', async () => {
    const app = await makeApp();
    const spec = app.swagger();
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toContain('/health/ready');
  });

  it('/docs varsayılan olarak kapalı', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
  });

  it('/docs açıkken basic auth ister', async () => {
    const app = await makeApp({
      env: { DOCS_ENABLED: 'true', DOCS_USER: 'team', DOCS_PASSWORD: 'super-secret-pass' },
    });
    expect((await app.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(401);
    const auth = `Basic ${Buffer.from('team:super-secret-pass').toString('base64')}`;
    const res = await app.inject({
      method: 'GET',
      url: '/docs/json',
      headers: { authorization: auth },
    });
    expect(res.statusCode).toBe(200);
  });
});
