import { describe, expect, it, vi } from 'vitest';
import { createCache } from '../../src/infra/cache.js';
import { fakeRedis } from '../helpers/fakes.js';

describe('cache', () => {
  it('önek, JSON ve TTL jitter (en fazla %10)', async () => {
    const client = fakeRedis();
    const cache = createCache({ client, prefix: 'mf:test', random: () => 0.999 });
    await cache.set('u:1:summary', { a: 1 }, 100);
    const entry = client.store.get('mf:test:u:1:summary');
    expect(entry?.value).toBe('{"a":1}');
    expect(entry?.ttl).toBe(109);
    expect(await cache.get('u:1:summary')).toEqual({ a: 1 });
    await cache.del('u:1:summary');
    expect(await cache.get('u:1:summary')).toBeNull();
  });

  it("getOrSet: ilk çağrı yükler, ikincisi cache'ten gelir; metrik sayar", async () => {
    const results = [];
    const cache = createCache({
      client: fakeRedis(),
      prefix: 'p',
      metrics: { record: (r) => results.push(r) },
    });
    const loader = vi.fn(async () => ({ v: 42 }));
    expect(await cache.getOrSet('k', 60, loader)).toEqual({ v: 42 });
    expect(await cache.getOrSet('k', 60, loader)).toEqual({ v: 42 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['miss', 'hit']);
  });

  it('single-flight: eşzamanlı istekler tek yükleme yapar', async () => {
    const cache = createCache({ client: fakeRedis(), prefix: 'p' });
    let release = () => {};
    const loader = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const pending = Promise.all([cache.getOrSet('k', 60, loader), cache.getOrSet('k', 60, loader)]);
    await new Promise((r) => setTimeout(r, 0));
    release({ v: 1 });
    expect(await pending).toEqual([{ v: 1 }, { v: 1 }]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('fail-open: Redis hatasında loader çalışır, hata fırlatılmaz', async () => {
    const results = [];
    const cache = createCache({
      client: fakeRedis({ fail: true }),
      prefix: 'p',
      metrics: { record: (r) => results.push(r) },
    });
    expect(await cache.getOrSet('k', 60, async () => 'taze')).toBe('taze');
    await expect(cache.del('k')).resolves.toBeUndefined();
    expect(results).toContain('error');
  });

  it("null değer cache'lenmez", async () => {
    const client = fakeRedis();
    const cache = createCache({ client, prefix: 'p' });
    expect(await cache.getOrSet('k', 60, async () => null)).toBeNull();
    expect(client.store.size).toBe(0);
  });
});
