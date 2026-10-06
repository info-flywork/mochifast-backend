/**
 * Sabit pencereli, process içi sayaç: "anahtar başına pencere içinde en fazla N".
 * `@fastify/rate-limit`'in IP/kullanıcı anahtarı dışında kalan sınırlar için (ör. installId).
 */
export function createWindowLimiter({ max, windowMs, maxKeys = 50_000, now = Date.now }) {
  const hits = new Map();

  function sweep(t) {
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
    // Hâlâ çok büyükse en eskileri at (bellek sınırı; Map ekleme sırasını korur).
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
  }

  return {
    /** Sayar; `{ allowed, retryAfterSec }` döner. */
    hit(key) {
      const t = now();
      if (hits.size > maxKeys) sweep(t);
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= max,
        retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)),
      };
    },
  };
}
