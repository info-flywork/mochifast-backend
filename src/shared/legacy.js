/**
 * Önek almayan eski istemci yolları (/auth/register, /user/me …) için: yanıta kullanımdan
 * kaldırıldı bilgisi eklenir, yeni yol `Link` header'ında bildirilir (RFC 8594/9745).
 */
export function deprecatedRoute(successorPath) {
  return {
    schema: { hide: true },
    onSend: async (_request, reply, payload) => {
      reply.header('deprecation', 'true');
      reply.header('link', `<${successorPath}>; rel="successor-version"`);
      return payload;
    },
  };
}

/**
 * Bir route eklentisinin servisini deps başına bir kez oluşturur: /v1 ve eski yollar aynı
 * örneği (ör. aynı process içi sayaçları) paylaşır.
 */
export function memoizeByDeps(factory) {
  const cache = new WeakMap();
  return (app) => {
    if (!cache.has(app.deps)) cache.set(app.deps, factory(app));
    return cache.get(app.deps);
  };
}
