import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

const base = {
  DB_HOST: 'localhost',
  DB_USER: 'app',
  DB_NAME: 'mochifast',
  JWT_PRIVATE_JWK: '{}',
  JWT_PUBLIC_JWKS: '[]',
  FIELD_ENCRYPTION_KEYS_JSON: '{}',
  FIELD_ENCRYPTION_ACTIVE_KID: '1',
};

/** Üretimde zorunlu medya ayarları (private zone token korumalı, public'ten ayrı). */
const prodMedia = {
  MEDIA_DRIVER: 'bunny',
  MEDIA_PATH_SECRET: 'x'.repeat(32),
  BUNNY_STORAGE_ZONE: 'mochifast',
  BUNNY_PULL_ZONE_HOST: 'mochifast.b-cdn.net',
  BUNNY_PRIVATE_STORAGE_ZONE: 'mochifast-private',
  BUNNY_PRIVATE_STORAGE_PASSWORD: 'secret',
  BUNNY_PRIVATE_PULL_ZONE_HOST: 'mochifast-private.b-cdn.net',
  BUNNY_TOKEN_AUTH_KEY: 'token-key',
};

describe('loadConfig', () => {
  it('varsayılanları uygular ve tipleri dönüştürür', () => {
    const c = loadConfig({
      ...base,
      PORT: '4000',
      DB_POOL_SIZE: '7',
      CORS_ORIGINS: ' https://a.app , https://b.app ',
    });
    expect(c.env).toBe('development');
    expect(c.server.port).toBe(4000);
    expect(c.db.poolSize).toBe(7);
    expect(c.db.port).toBe(3306);
    expect(c.cors.origins).toEqual(['https://a.app', 'https://b.app']);
    expect(c.server.trustProxy).toBe(false);
  });

  it('zorunlu değişken eksikse başlamaz', () => {
    const { DB_HOST: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/DB_HOST/);
  });

  it('geçersiz enum değerini reddeder', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'prod' })).toThrow();
  });

  it('TRUST_PROXY hop sayısını ve boolean değerleri ayrıştırır', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '2' }).server.trustProxy).toBe(2);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).server.trustProxy).toBe(true);
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'maybe' })).toThrow(/TRUST_PROXY/);
  });

  it('üretimde uzak MySQL için DB_SSL zorunlu, localhost için değil', () => {
    const remote = { ...base, ...prodMedia, NODE_ENV: 'production', DB_HOST: 'db.example.com' };
    expect(() => loadConfig(remote)).toThrow(/DB_SSL/);
    expect(loadConfig({ ...remote, DB_SSL: 'true' }).isProduction).toBe(true);
    expect(loadConfig({ ...base, ...prodMedia, NODE_ENV: 'production' }).isProduction).toBe(true);
  });

  it('DB_SSL_VERIFY=false yalnızca üretim dışında', () => {
    const remote = { ...base, DB_HOST: 'db.example.com', DB_SSL: 'true', DB_SSL_VERIFY: 'false' };
    expect(loadConfig(remote).db.sslVerify).toBe(false);
    expect(() => loadConfig({ ...remote, ...prodMedia, NODE_ENV: 'production' })).toThrow(
      /DB_SSL_VERIFY/,
    );
  });

  it('medya: üretimde bunny + güçlü yol sırrı; private zone public ile aynı olamaz', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(() => loadConfig(prod)).toThrow(/MEDIA_DRIVER=bunny/);
    expect(() => loadConfig({ ...prod, ...prodMedia, MEDIA_PATH_SECRET: 'short' })).toThrow(
      /MEDIA_PATH_SECRET/,
    );
    const { BUNNY_TOKEN_AUTH_KEY: _k, ...noToken } = prodMedia;
    expect(() => loadConfig({ ...prod, ...noToken })).toThrow(/BUNNY_TOKEN_AUTH_KEY/);
    // Token'sız public CDN'e kullanıcı fotoğrafı yazılmasın.
    expect(() =>
      loadConfig({ ...prod, ...prodMedia, BUNNY_PRIVATE_PULL_ZONE_HOST: 'mochifast.b-cdn.net' }),
    ).toThrow(/public zone/);
    const c = loadConfig({ ...base });
    expect(c.media).toMatchObject({ driver: 'local', uploadMaxBytes: 10 * 1024 * 1024 });
    expect(c.media.pathSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('belgeler açıksa güçlü basic auth ister', () => {
    expect(() =>
      loadConfig({ ...base, DOCS_ENABLED: 'true', DOCS_USER: 'x', DOCS_PASSWORD: 'short' }),
    ).toThrow();
    expect(
      loadConfig({
        ...base,
        DOCS_ENABLED: 'true',
        DOCS_USER: 'x',
        DOCS_PASSWORD: 'long-enough-pass',
      }).docs.enabled,
    ).toBe(true);
  });

  it('dondurulmuştur', () => {
    const c = loadConfig(base);
    expect(Object.isFrozen(c.db)).toBe(true);
  });
});
