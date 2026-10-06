/**
 * Katalog yanıtlarının HTTP cache başlıkları (docs/backend/07-cache-performans.md §5).
 * ETag ve 304'ü @fastify/etag verir (yanıt gövdesinin hash'i).
 *
 * @param options.personal yanıt kullanıcıya özel mi (ör. premium kilit görünümü)
 * @param options.vary ek Vary başlıkları
 */
export function setCatalogCacheHeaders(reply, { personal = false, vary = [] } = {}) {
  reply.header(
    'cache-control',
    personal ? 'private, max-age=60' : 'public, max-age=300, stale-while-revalidate=86400',
  );
  reply.header(
    'vary',
    ['Accept-Language', ...(personal ? ['Authorization'] : []), ...vary].join(', '),
  );
}
