import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '../shared/errors.js';

/**
 * Global rate limit (docs/backend/06-guvenlik.md §7). Route bazında daha sıkı limitler
 * `config: { rateLimit: { max, timeWindow } }` ile verilir; kapatmak için `rateLimit: false`.
 * Sayaçlar process belleğindedir (API tek process çalışır; docs/adr/0005-redis-yok.md).
 * Kota/AI gibi kalıcı sınır gereken yerler kendi kontrolünü DB'de yapar.
 */
export default fp(
  async function rateLimitPlugin(app) {
    const { config } = app;
    await app.register(rateLimit, {
      global: true,
      max: config.rateLimit.globalMax,
      timeWindow: config.rateLimit.window,
      // Oturum açılmışsa kullanıcı, değilse IP (trustProxy ile gerçek istemci IP'si).
      keyGenerator: (request) => {
        const userId = request.user?.id;
        return userId ? `u:${userId}` : `ip:${request.ip}`;
      },
      errorResponseBuilder: (_request, context) => {
        const retryAfterSec = Math.max(1, Math.ceil(context.ttl / 1000));
        return new AppError('RATE_LIMITED', {
          details: { retryAfterSec },
          headers: { 'retry-after': String(retryAfterSec) },
        });
      },
    });
  },
  { name: 'rate-limit' },
);
