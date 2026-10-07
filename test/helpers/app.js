import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { buildApp } from '../../src/app.js';
import { createAiClient } from '../../src/infra/anthropic.js';
import { createMediaStorage } from '../../src/infra/bunny.js';
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
 * Ağa çıkmayan Claude istemcisi: `respond(fn)` ile yanıt (ya da hata) test belirler,
 * `calls` gönderilen parametreleri tutar.
 */
export function fakeAnthropic() {
  const calls = [];
  let handler = () => {
    throw new Error('fakeAnthropic: yanıt tanımlanmadı');
  };
  return {
    calls,
    respond(fn) {
      handler = fn;
    },
    beta: {
      messages: {
        async create(params, options) {
          calls.push(params);
          return handler(params, options);
        },
        stream(params, options) {
          calls.push(params);
          return handler(params, options);
        },
      },
    },
  };
}

/** Claude yanıtı biçiminde mesaj (yapılandırılmış çıktı JSON metin bloğunda). */
export function aiMessage(
  body,
  { stopReason = 'end_turn', model = 'claude-opus-5-5', usage } = {},
) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
    stop_reason: stopReason,
    usage: usage ?? { input_tokens: 1500, output_tokens: 400, cache_read_input_tokens: 0 },
  };
}

/**
 * Gerçek MySQL (geçici veritabanı, tüm migration'lar) üzerinde tam uygulama + istek yardımcıları.
 */
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
  const anthropic = fakeAnthropic();
  const ai = createAiClient({ ...config.ai, enabled: true }, { clientImpl: anthropic });
  const app = await buildApp({
    config,
    logger: false,
    deps: {
      db,
      cache: createCache(),
      jobs: createJobQueue(db),
      tokens: await createTokenService(config.auth),
      crypto,
      firebase: createFirebaseVerifier({ ...config.firebase, jwks: firebaseKeys.jwks }),
      storage,
      ai,
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

  const guest = (installId = randomUUID(), extra = {}) =>
    call('POST', '/auth/guest', {
      body: { installId, platform: 'ios', locale: 'tr', timezone: 'Europe/Istanbul', ...extra },
    });

  /** Firebase ile (varsayılan Apple) giriş: POST /v1/auth/register { provider: 'firebase' }. */
  async function firebaseLogin({ uid, token, mergeGuest, provider, fullName, ...claims }) {
    const idToken = await firebaseKeys.sign({ uid, provider, ...claims });
    return call('POST', '/auth/register', {
      token,
      body: {
        provider: 'firebase',
        idToken,
        deviceId: randomUUID(),
        platform: 'ios',
        ...(fullName ? { fullName } : {}),
        ...(mergeGuest === undefined ? {} : { mergeGuest }),
      },
    });
  }

  return {
    app,
    db,
    storage,
    mediaDir,
    ai,
    anthropic,
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
