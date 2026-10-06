import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { AppError } from '../shared/errors.js';

/**
 * Global rate limit (docs/backend/06-guvenlik.md §7). Route bazında daha sıkı limitler
 * `config: { rateLimit: { max, timeWindow } }` ile verilir; kapatmak için `rateLimit: false`.
 * Redis erişilemezse istek GEÇİRİLİR (skipOnError) — kota/AI gibi fail-closed gereken yerler
 * kendi kontrolünü yapar.
 */
export default fp(
  async function rateLimitPlugin(app) {
    const { config, deps } = app;
    // Replikalar arası ortak sayaç için Redis store; gerçek bağlantı yoksa (testler) bellek içi store.
    const redis = deps.cacheRedis instanceof Redis ? deps.cacheRedis : undefined;
    if (!redis && config.env !== 'test') {
      app.log.warn('rate limit Redis olmadan çalışıyor: sayaçlar replika başına tutulur');
    }
    await app.register(rateLimit, {
      global: true,
      max: config.rateLimit.globalMax,
      timeWindow: config.rateLimit.window,
      ...(redis ? { redis } : {}),
      nameSpace: `${config.redis.keyPrefix}:${config.env}:rl:`,
      skipOnError: true,
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
