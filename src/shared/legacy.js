/**
 * Bir route eklentisinin servisini deps başına bir kez oluşturur: aynı servisi kullanan
 * eklentiler aynı örneği (ör. aynı process içi sayaçları) paylaşır.
 */
export function memoizeByDeps(factory) {
  const cache = new WeakMap();
  return (app) => {
    if (!cache.has(app.deps)) cache.set(app.deps, factory(app));
    return cache.get(app.deps);
  };
}
