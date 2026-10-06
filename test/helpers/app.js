import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT, createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair } from 'jose';
import { buildApp } from '../../src/app.js';
import { createCache } from '../../src/infra/cache.js';
import { createFieldCrypto } from '../../src/infra/crypto.js';
import { createDatabase } from '../../src/infra/db.js';
import { createIdentityProviders } from '../../src/infra/identity-providers.js';
import { migrate } from '../../src/infra/migrator.js';
import { createJobQueue } from '../../src/infra/queue.js';
import { createTokenService } from '../../src/infra/tokens.js';
import { createTestDatabase, testConfig } from './infra.js';

export const BUNDLE_ID = 'com.flywork.mochifast';
export const GOOGLE_CLIENT = 'test-google-client.apps.googleusercontent.com';
const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

export const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/** Apple/Google yerine testte imzalanan kimlik token'ları. */
export async function fakeProvider(kid) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256' }],
  });
  const sign = (claims, { iss, aud }) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  return { jwks, sign };
}

/**
 * Gerçek MySQL (geçici veritabanı, tüm migration'lar) üzerinde tam uygulama + istek yardımcıları.
 */
export async function createIntegrationApp(mysqlUrl, env = {}) {
  const testDb = await createTestDatabase(mysqlUrl);
  const appleKey = await generateKeyPair('ES256', { extractable: true });
  const config = testConfig({
    ...testDb.env,
    GOOGLE_CLIENT_IDS: GOOGLE_CLIENT,
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEY_ID: 'KEY1234567',
    APPLE_PRIVATE_KEY_P8: await exportPKCS8(appleKey.privateKey),
    ...env,
  });
  await migrate({ dbConfig: config.db, dir: migrationsDir, logger: silent });
  const db = createDatabase(config.db);
  const apple = await fakeProvider('apple-1');
  const google = await fakeProvider('google-1');
  const crypto = createFieldCrypto(config.fieldEncryption);
  const appleExchanges = [];
  const fetch = async (url, init) => {
    appleExchanges.push({ url, body: Object.fromEntries(init.body) });
    return new Response(JSON.stringify({ refresh_token: 'apple-refresh-xyz' }), { status: 200 });
  };
  const app = await buildApp({
    config,
    logger: false,
    deps: {
      db,
      cache: createCache(),
      jobs: createJobQueue(db),
      tokens: await createTokenService(config.auth),
      crypto,
      identity: createIdentityProviders({
        config: config.identity,
        appleJwks: apple.jwks,
        googleJwks: google.jwks,
        fetch,
      }),
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

  async function appleLogin({
    sub,
    token,
    mergeGuest,
    code,
    email = `${sub}@privaterelay.appleid.com`,
  }) {
    const nonce = randomBytes(16).toString('hex');
    const idToken = await apple.sign(
      { sub, nonce: sha256(nonce), email, email_verified: 'true' },
      { iss: 'https://appleid.apple.com', aud: BUNDLE_ID },
    );
    return call('POST', '/auth/register', {
      token,
      body: {
        provider: 'apple',
        idToken,
        nonce,
        deviceId: randomUUID(),
        platform: 'ios',
        fullName: { givenName: 'Atilla', familyName: 'E.' },
        ...(code ? { authorizationCode: code } : {}),
        ...(mergeGuest === undefined ? {} : { mergeGuest }),
      },
    });
  }

  return {
    app,
    db,
    config,
    crypto,
    apple,
    google,
    appleExchanges,
    call,
    guest,
    appleLogin,
    async close() {
      await app.close();
      await db.close();
      await testDb.drop();
    },
  };
}
