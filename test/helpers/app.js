import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { buildApp } from '../../src/app.js';
import { createMediaStorage } from '../../src/infra/bunny.js';
import { createChatClient, createVisionClient } from '../../src/infra/openai.js';
import { createRevenueCatClient } from '../../src/infra/revenuecat.js';
import { createEntitlements } from '../../src/modules/billing/billing.service.js';
import { createCache } from '../../src/infra/cache.js';
import { createFieldCrypto } from '../../src/infra/crypto.js';
import { createDatabase } from '../../src/infra/db.js';
import { createFirebaseVerifier } from '../../src/infra/firebase-auth.js';
import { migrate } from '../../src/infra/migrator.js';
import { loadCatalogSeeds, seedCatalog } from '../../src/modules/catalog/catalog.seeder.js';
import { createJobQueue } from '../../src/infra/queue.js';
import { createTokenService } from '../../src/infra/tokens.js';
import { createTestDatabase, testConfig } from './infra.js';

export const FIREBASE_PROJECT = 'mochifast-test';
const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Firebase'in yerine testte imzalanan ID token'lar (securetoken JWKS'in yerel karşılığı). */
export async function fakeFirebase(kid = 'firebase-1') {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256' }],
  });
  /** Varsayılan: geçerli bir Apple girişi. `claims`/`options` ile her alan bozulabilir. */
  const sign = (
    { uid, provider = 'apple.com', ...claims },
    {
      iss = `https://securetoken.google.com/${FIREBASE_PROJECT}`,
      aud = FIREBASE_PROJECT,
      exp = '5m',
    } = {},
  ) =>
    new SignJWT({
      auth_time: Math.floor(Date.now() / 1000) - 5,
      firebase: { sign_in_provider: provider, identities: {} },
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject(uid)
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(privateKey);
  return { jwks, sign };
}

/**
 * Ağa çıkmayan OpenAI istemcisi. `respond(fn)`: fn(params, options) → async iterable parça listesi
 * (akış) ya da tamamlanmış yanıt (stream olmayan çağrı). `chunks(...)` yardımcıyla parça üretir.
 */
export function fakeOpenAI() {
  const calls = [];
  let handler = () => {
    throw new Error('fakeOpenAI: yanıt tanımlanmadı');
  };
  return {
    calls,
    respond(fn) {
      handler = fn;
    },
    chat: {
      completions: {
        async create(params, options) {
          calls.push(params);
          return handler(params, options);
        },
      },
    },
  };
}

/**
 * Chat Completions akış parçaları. `texts`: metin parçaları; `delayMs`: parçalar arası bekleme
 * (iptal testleri); `signal` verilirse iptalde SDK gibi APIUserAbortError fırlatır.
 */
export async function* openAiChunks(
  texts,
  { finish = 'stop', usage, model = 'test-chat-model', delayMs = 0, signal, refusal } = {},
) {
  const { default: OpenAI } = await import('openai');
  for (const text of texts) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (signal?.aborted) throw new OpenAI.APIUserAbortError();
    yield { model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
  }
  if (refusal) yield { model, choices: [{ index: 0, delta: { refusal }, finish_reason: null }] };
  yield { model, choices: [{ index: 0, delta: {}, finish_reason: finish }] };
  yield {
    model,
    choices: [],
    usage: usage ?? {
      prompt_tokens: 900,
      completion_tokens: 60,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

/**
 * Ağa çıkmayan RevenueCat REST'i: `subscribers[appUserId]` yanıtı test belirler;
 * promosyon isteği entitlement ekler. `calls` istekleri tutar.
 */
export function fakeRevenueCat() {
  const subscribers = {};
  const calls = [];
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return {
    subscribers,
    calls,
    async fetch(url, init) {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      const m = String(url).match(/\/subscribers\/([^/]+)(\/entitlements\/([^/]+)\/promotional)?$/);
      const id = decodeURIComponent(m?.[1] ?? '');
      if (m?.[2]) {
        const expires = new Date(Date.now() + 30 * 86_400_000).toISOString();
        subscribers[id] = {
          entitlements: {
            [m[3]]: {
              expires_date: expires,
              product_identifier: 'rc_promo_premium_monthly',
              purchase_date: new Date().toISOString(),
            },
          },
          subscriptions: {},
        };
        return json({ subscriber: subscribers[id] }, 201);
      }
      return json({ subscriber: subscribers[id] ?? { entitlements: {}, subscriptions: {} } });
    },
  };
}

/**
 * Ağa çıkmayan FCM: gönderilen mesajları tutar; `fail[token] = 'messaging/…'` ile hata döner.
 */
export function fakePush() {
  const sent = [];
  const fail = {};
  return {
    sent,
    fail,
    async sendImpl(messages) {
      return messages.map((m) => {
        if (fail[m.token]) return { success: false, errorCode: fail[m.token] };
        sent.push(m);
        return { success: true, messageId: `msg-${sent.length}` };
      });
    },
  };
}

/** OpenAI Chat Completions yanıtı (fotoğraf analizi testleri). */
export function aiMessage(
  body,
  { finishReason = 'stop', refusal = null, model = 'gpt-4o', usage } = {},
) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    id: 'chatcmpl_test',
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text, refusal },
        finish_reason: finishReason,
      },
    ],
    usage: usage ?? {
      prompt_tokens: 1500,
      completion_tokens: 400,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

/**
 * Gerçek MySQL (geçici veritabanı, tüm migration'lar) üzerinde tam uygulama + istek yardımcıları.
 */
/**
 * `app_config.features` içinde bir bayrağı değiştirir ve önbelleği temizler
 * (seed'deki geliştirme ayarları testlerin varsayımlarından farklı olabilir).
 */
export async function setFeatureFlag(ctx, key, enabled) {
  const where = `config_key = 'features' AND platform = 'all'`;
  const row = await ctx.db.one(`SELECT value FROM app_config WHERE ${where}`);
  const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  await ctx.db.run(`UPDATE app_config SET value = :value WHERE ${where}`, {
    value: JSON.stringify({ ...value, [key]: enabled }),
  });
  await ctx.app.deps.cache.delPrefix('');
}

export async function createIntegrationApp(mysqlUrl, env = {}) {
  const testDb = await createTestDatabase(mysqlUrl);
  const config = testConfig({
    ...testDb.env,
    FIREBASE_PROJECT_ID: FIREBASE_PROJECT,
    ...env,
  });
  await migrate({ dbConfig: config.db, dir: migrationsDir, logger: silent });
  const db = createDatabase(config.db);
  await seedCatalog(db, await loadCatalogSeeds());
  const firebaseKeys = await fakeFirebase();
  const crypto = createFieldCrypto(config.fieldEncryption);
  const mediaDir = await mkdtemp(join(tmpdir(), 'mochifast-media-'));
  const storage = createMediaStorage(
    { ...config.media, localDir: mediaDir },
    { baseUrl: 'http://media.test' },
  );
  const openai = fakeOpenAI();
  const ai = createVisionClient(
    { ...config.ai, enabled: true, visionModel: 'gpt-4o', apiKey: 'test' },
    { clientImpl: openai },
  );
  const chat = createChatClient(
    {
      ...config.chatAi,
      enabled: true,
      model: 'test-chat-model',
      firstTokenMs: 2000,
      totalMs: 5000,
    },
    { clientImpl: openai },
  );
  const cache = createCache();
  const revenuecatApi = fakeRevenueCat();
  const revenuecat = createRevenueCatClient(
    { ...config.billing, enabled: true, secretApiKey: 'sk_test' },
    { fetchImpl: revenuecatApi.fetch },
  );
  const entitlements = createEntitlements({ db, cache, config: config.billing });
  const app = await buildApp({
    config,
    logger: false,
    deps: {
      db,
      cache,
      jobs: createJobQueue(db),
      tokens: await createTokenService(config.auth),
      crypto,
      firebase: createFirebaseVerifier({ ...config.firebase, jwks: firebaseKeys.jwks }),
      storage,
      ai,
      chat,
      revenuecat,
      entitlements,
    },
  });

  const rand = () => Math.floor(Math.random() * 250) + 1;
  /** Her istek farklı IP'den: IP rate limit'leri testleri etkilemesin. `url` /v1'siz verilir. */
  function call(method, url, { body, token, headers, prefix = '/v1' } = {}) {
    return app.inject({
      method,
      url: `${prefix}${url}`,
      payload: body,
      remoteAddress: `10.${rand()}.${rand()}.${rand()}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
  }

  /**
   * Misafir girişi. Aynı installId ile tekrar girişte, oluşturulurken dönen misafir sırrı
   * otomatik gönderilir (`extra.guestSecret` verilirse o kullanılır; `null` → gönderilmez).
   */
  const guestSecrets = new Map();
  const guest = async (installId = randomUUID(), extra = {}) => {
    const body = { installId, platform: 'ios', locale: 'tr', timezone: 'Europe/Istanbul' };
    if (guestSecrets.has(installId)) body.guestSecret = guestSecrets.get(installId);
    Object.assign(body, extra);
    if (body.guestSecret === null) delete body.guestSecret;
    const res = await call('POST', '/auth/guest', { body });
    const secret = res.statusCode < 300 ? res.json().data.guestSecret : null;
    if (secret) guestSecrets.set(installId, secret);
    return res;
  };

  /** Firebase ile (varsayılan Apple) giriş: POST /v1/auth/register { provider: 'firebase' }. */
  async function firebaseLogin({ uid, token, provider, fullName, ...claims }) {
    const idToken = await firebaseKeys.sign({ uid, provider, ...claims });
    return call('POST', '/auth/register', {
      token,
      body: {
        provider: 'firebase',
        idToken,
        deviceId: randomUUID(),
        platform: 'ios',
        ...(fullName ? { fullName } : {}),
      },
    });
  }

  return {
    app,
    db,
    storage,
    mediaDir,
    ai,
    openai,
    chat,
    revenuecatApi,
    entitlements,
    config,
    crypto,
    firebase: firebaseKeys,
    call,
    guest,
    firebaseLogin,
    async close() {
      await app.close();
      await db.close();
      await testDb.drop();
      await rm(mediaDir, { recursive: true, force: true });
    },
  };
}
