/**
 * Process içi cache-aside katmanı (docs/adr/0005-redis-yok.md).
 * - LRU: `maxEntries` aşılınca en uzun süredir kullanılmayan anahtar atılır.
 * - TTL jitter: aynı anda süresi dolan anahtar yığılmasını önler.
 * - Single-flight: aynı anahtar için eşzamanlı yüklemeler tekleştirilir.
 * - Değerler JSON olarak saklanır: çağıran, dönen nesneyi değiştirse de cache bozulmaz.
 * API async'tir; ileride paylaşımlı bir store'a geçilirse çağıranlar değişmez.
 *
 * Not: cache process'e özeldir. API tek process çalışır (ecosystem.config.cjs); birden çok
 * kopyaya çıkılırsa invalidation yalnızca o kopyada geçerli olur.
 */

/**
 * @param [deps.maxEntries] en fazla anahtar sayısı
 * @param [deps.now] test için saat
 * @param [deps.random] test için
 */
export function createCache({
  maxEntries = 10_000,
  metrics,
  now = Date.now,
  random = Math.random,
} = {}) {
  // Map ekleme sırasını korur: ilk anahtar = en uzun süredir kullanılmayan.
  const store = new Map();
  const inflight = new Map();

  function read(k) {
    const entry = store.get(k);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      store.delete(k);
      return null;
    }
    // Kullanılanı sona taşı (LRU).
    store.delete(k);
    store.set(k, entry);
    return JSON.parse(entry.json);
  }

  const cache = {
    get size() {
      return store.size;
    },

    async get(k) {
      return read(k);
    },

    async set(k, value, ttlSec) {
      const jitter = Math.floor(ttlSec * 0.1 * random());
      store.delete(k);
      store.set(k, { json: JSON.stringify(value), expiresAt: now() + (ttlSec + jitter) * 1000 });
      while (store.size > maxEntries) {
        store.delete(store.keys().next().value);
        metrics?.record('evict');
      }
    },

    async del(...keys) {
      for (const k of keys) store.delete(k);
    },

    /** Önekle başlayan tüm anahtarları siler (ör. bir kullanıcının tüm özetleri: "u:42:"). */
    async delPrefix(prefix) {
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },

    async getOrSet(k, ttlSec, loader) {
      const cached = read(k);
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
