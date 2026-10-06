import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

const base = {
  DB_HOST: 'localhost',
  DB_USER: 'app',
  DB_NAME: 'mochifast',
  REDIS_CACHE_URL: 'redis://localhost:6379',
  REDIS_QUEUE_URL: 'redis://localhost:6380',
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
    const remote = { ...base, NODE_ENV: 'production', DB_HOST: 'db.example.com' };
    expect(() => loadConfig(remote)).toThrow(/DB_SSL/);
    expect(loadConfig({ ...remote, DB_SSL: 'true' }).isProduction).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).isProduction).toBe(true);
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
