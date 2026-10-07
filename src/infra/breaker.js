import { AppError } from '../shared/errors.js';

/**
 * Basit devre kesici: art arda `threshold` geçici hatadan sonra `openMs` boyunca çağrı yapılmaz,
 * 503 döner. Dış servis çöktüğünde maliyeti, gecikmeyi ve kuyruğu korur.
 * @param isTransient hata → bu hata sayılsın mı (kalıcı istek hataları sayılmaz)
 */
export function createBreaker({
  name,
  isTransient,
  threshold = 5,
  openMs = 30_000,
  now = Date.now,
  logger,
}) {
  let failures = 0;
  let openUntil = 0;
  return {
    guard() {
      if (now() < openUntil) {
        throw new AppError('UNAVAILABLE', { details: { reason: `${name}_circuit_open` } });
      }
    },
    success() {
      failures = 0;
    },
    failure(err) {
      if (!isTransient(err)) return;
      failures += 1;
      if (failures >= threshold) {
        openUntil = now() + openMs;
        failures = 0;
        logger?.warn({ breaker: name, openMs }, 'devre kesici açıldı');
      }
    },
  };
}
