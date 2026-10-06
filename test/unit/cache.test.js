import { describe, expect, it, vi } from 'vitest';
import { createCache } from '../../src/infra/cache.js';

describe('cache', () => {
  it('TTL (jitter en fazla %10) dolunca anahtar düşer', async () => {
    let t = 0;
    const cache = createCache({ now: () => t, random: () => 0.999 });
    await cache.set('k', { a: 1 }, 100);
    t = 108_999;
    expect(await cache.get('k')).toEqual({ a: 1 });
    t = 109_000;
    expect(await cache.get('k')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('dönen nesneyi değiştirmek cache içeriğini bozmaz', async () => {
    const cache = createCache();
    await cache.set('k', { list: [1] }, 60);
    (await cache.get('k')).list.push(2);
    expect(await cache.get('k')).toEqual({ list: [1] });
  });

  it('LRU: sınır aşılınca en uzun süredir kullanılmayan atılır', async () => {
    const results = [];
    const cache = createCache({ maxEntries: 2, metrics: { record: (r) => results.push(r) } });
    await cache.set('a', 1, 60);
    await cache.set('b', 2, 60);
    await cache.get('a'); // a artık en yeni
    await cache.set('c', 3, 60);
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('a')).toBe(1);
    expect(await cache.get('c')).toBe(3);
    expect(results).toEqual(['evict']);
  });

  it('del ve delPrefix', async () => {
    const cache = createCache();
    await cache.set('u:1:summary', 1, 60);
    await cache.set('u:1:streak', 2, 60);
    await cache.set('u:2:summary', 3, 60);
    await cache.delPrefix('u:1:');
    expect(cache.size).toBe(1);
    await cache.del('u:2:summary');
    expect(cache.size).toBe(0);
  });

  it("getOrSet: ilk çağrı yükler, ikincisi cache'ten gelir; metrik sayar", async () => {
    const results = [];
    const cache = createCache({ metrics: { record: (r) => results.push(r) } });
    const loader = vi.fn(async () => ({ v: 42 }));
    expect(await cache.getOrSet('k', 60, loader)).toEqual({ v: 42 });
    expect(await cache.getOrSet('k', 60, loader)).toEqual({ v: 42 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['miss', 'hit']);
  });

  it('single-flight: eşzamanlı istekler tek yükleme yapar', async () => {
    const cache = createCache();
    let release = () => {};
    const loader = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const pending = Promise.all([cache.getOrSet('k', 60, loader), cache.getOrSet('k', 60, loader)]);
    await new Promise((r) => setTimeout(r, 0));
    release({ v: 1 });
    expect(await pending).toEqual([{ v: 1 }, { v: 1 }]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("yükleme hatası cache'lenmez, sonraki çağrı tekrar dener", async () => {
    const cache = createCache();
    await expect(
      cache.getOrSet('k', 60, async () => {
        throw new Error('db');
      }),
    ).rejects.toThrow('db');
    expect(await cache.getOrSet('k', 60, async () => 'ok')).toBe('ok');
  });

  it("null değer cache'lenmez", async () => {
    const cache = createCache();
    expect(await cache.getOrSet('k', 60, async () => null)).toBeNull();
    expect(cache.size).toBe(0);
  });
});
