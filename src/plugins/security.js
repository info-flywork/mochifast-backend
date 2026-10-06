import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import underPressure from '@fastify/under-pressure';
import etag from '@fastify/etag';
import { AppError } from '../shared/errors.js';

/**
 * Güvenlik başlıkları, CORS, aşırı yük koruması, ETag ve varsayılan cache politikası.
 * (docs/backend/06-guvenlik.md)
 */
export default fp(
  async function security(app) {
    const { config } = app;

    // JSON API: CSP gereksiz (HTML sunmuyoruz). Diğer başlıklar açık.
    // HSTS ters proxy'de verilir (TLS orada sonlanır).
    await app.register(helmet, { contentSecurityPolicy: false, hsts: false });

    // Mobil istemci CORS kullanmaz; yalnızca yönetim paneli origin'lerine izin verilir.
    await app.register(cors, {
      origin: config.cors.origins.length > 0 ? [...config.cors.origins] : false,
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxAge: 600,
    });

    // Event loop / heap baskısında 503 → LB başka replikaya yönlendirir.
    await app.register(underPressure, {
      maxEventLoopDelay: 1_000,
      maxEventLoopUtilization: 0.98,
      retryAfter: 10,
      exposeStatusRoute: false,
      pressureHandler: (_request, reply) => {
        reply.header('retry-after', '10');
        throw new AppError('UNAVAILABLE');
      },
    });

    await app.register(etag);

    // Varsayılan: kişisel veri cache'lenmez. Katalog uçları kendi Cache-Control'ünü koyar.
    app.addHook('onSend', async (_request, reply, payload) => {
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'private, no-store');
      return payload;
    });
  },
  { name: 'security' },
);
