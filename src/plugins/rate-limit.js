import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { AppError } from '../shared/errors.js';
import { rateKeyForIp } from '../shared/ip.js';

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
      // Geçerli access token varsa kullanıcı, yoksa IP (IPv6 /64). Limit `onRequest`'te,
      // kimlik doğrulamadan ÖNCE çalışır: `request.user` henüz yok, token burada doğrulanır
      // (imzasız/sahte token başka kullanıcının sayacını tüketemez).
      keyGenerator: async (request) => {
        const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
        if (match && app.deps.tokens) {
          try {
            const { userId } = await app.deps.tokens.verifyAccess(match[1]);
            return `u:${userId}`;
          } catch {
            // Geçersiz/süresi dolmuş token: IP'ye düşer; istek auth'ta zaten reddedilir.
          }
        }
        return `ip:${rateKeyForIp(request.ip)}`;
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
