/**
 * Cache-aside katmanı (docs/backend/07-cache-performans.md §4).
 * - Fail-open: Redis hatasında cache atlanır, loader çalışır, uygulama durmaz.
 * - Single-flight: aynı process'te aynı anahtar için eşzamanlı yüklemeler tekleştirilir.
 * - TTL jitter: aynı anda süresi dolan anahtar yığılmasını önler.
 * Anahtarlar otomatik olarak `<prefix>:<env>:` ile öneklenir.
 */

/**
 * @param deps.prefix ör. "mf:prod"
 * @param [deps.random] test için
 */
export function createCache({ client, prefix, logger, metrics, random = Math.random }) {
  const inflight = new Map();
  let lastErrorLog = 0;

  function onError(err) {
    metrics?.record('error');
    const now = Date.now();
    if (now - lastErrorLog > 10_000) {
      lastErrorLog = now;
      logger?.warn({ err: err instanceof Error ? err.message : err }, 'cache hatası (fail-open)');
    }
  }

  const fullKey = (k) => `${prefix}:${k}`;

  const cache = {
    key: fullKey,

    async get(k) {
      try {
        const raw = await client.get(fullKey(k));
        return raw === null ? null : JSON.parse(raw);
      } catch (err) {
        onError(err);
        return null;
      }
    },

    async set(k, value, ttlSec) {
      try {
        const jitter = Math.floor(ttlSec * 0.1 * random());
        await client.set(fullKey(k), JSON.stringify(value), 'EX', ttlSec + jitter);
      } catch (err) {
        onError(err);
      }
    },

    async del(...keys) {
      if (keys.length === 0) return;
      try {
        await client.del(...keys.map(fullKey));
      } catch (err) {
        onError(err);
      }
    },

    async getOrSet(k, ttlSec, loader) {
      const cached = await cache.get(k);
      if (cached !== null) {
        metrics?.record('hit');
        return cached;
      }
      metrics?.record('miss');

      const pending = inflight.get(k);
      if (pending) return pending;

      const promise = (async () => {
        try {
          const value = await loader();
          // `null` cache'lenmez (get null ile "yok"u ayıramaz); negatif cache için sentinel kullanın.
          if (value !== null && value !== undefined) await cache.set(k, value, ttlSec);
          return value;
        } finally {
          inflight.delete(k);
        }
      })();
      inflight.set(k, promise);
      return promise;
    },
  };
  return cache;
}
