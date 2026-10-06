/**
 * Bellek içi Redis sahtesi (cache katmanının kullandığı alt küme).
 * `fail: true` ile her komut hata verir (fail-open davranışını test etmek için).
 */
export function fakeRedis({ fail = false } = {}) {
  const store = new Map();
  const guard = () => {
    if (fail) throw new Error('redis down');
  };
  return {
    store,
    async get(key) {
      guard();
      return store.get(key)?.value ?? null;
    },
    async set(key, value, _mode, ttl) {
      guard();
      store.set(key, { value, ttl });
      return 'OK';
    },
    async del(...keys) {
      guard();
      let n = 0;
      for (const k of keys) if (store.delete(k)) n += 1;
      return n;
    },
    async ping() {
      guard();
      return 'PONG';
    },
  };
}

/** Altyapıya dokunmayan HTTP testleri için bağımlılıklar. */
export function fakeDeps({ dbUp = true } = {}) {
  const cacheClient = fakeRedis();
  return {
    db: {
      async ping() {
        if (!dbUp) throw new Error('db down');
      },
      poolStats: () => ({ total: 0, free: 0, queued: 0 }),
    },
    cacheRedis: null,
    queueRedis: { ping: async () => 'PONG' },
    cache: { client: cacheClient },
  };
}
