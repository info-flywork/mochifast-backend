/** Altyapıya dokunmayan HTTP testleri için bağımlılıklar. */
export function fakeDeps({ dbUp = true } = {}) {
  return {
    db: {
      async ping() {
        if (!dbUp) throw new Error('db down');
      },
      poolStats: () => ({ total: 0, free: 0, queued: 0 }),
    },
    cache: {},
    jobs: { enqueue: async () => ({ id: 1, deduped: false }) },
  };
}
