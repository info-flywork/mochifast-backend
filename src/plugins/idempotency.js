import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import { HEADERS } from '../config/constants.js';
import { AppError } from '../shared/errors.js';
import { toBin } from '../shared/ids.js';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const TTL_HOURS = 24;
const ER_DUP_ENTRY = 1062;

/**
 * Idempotency-Key (docs/backend/02-mimari.md §4.3). Route'ta `preHandler: [app.requireAuth,
 * app.idempotent]` ile açılır; başlık yoksa istek normal işlenir.
 *
 * - İlk istek: kayıt "işleniyor" olarak eklenir, yanıt (5xx hariç) kaydedilir.
 * - Aynı anahtar + aynı gövde: kaydedilen yanıt aynen döner (`idempotent-replayed: true`).
 * - Aynı anahtar + farklı gövde: 409 IDEMPOTENCY_KEY_REUSED. İlk istek sürerken: 409 CONFLICT.
 * - 5xx yanıtta kayıt silinir: istemci aynı anahtarla yeniden deneyebilir.
 * Kayıtlar 24 saat tutulur; süresi dolanları `idempotencyCleanup` işi siler.
 */
export default fp(
  async function idempotency(app) {
    app.decorateRequest('idempotency', null);

    app.decorate('idempotent', async function idempotent(request, reply) {
      const key = request.headers[HEADERS.idempotencyKey];
      if (key === undefined) return;
      if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
        throw new AppError('VALIDATION_FAILED', {
          details: { fields: [{ path: 'Idempotency-Key', message: 'invalid format' }] },
        });
      }
      const { db } = app.deps;
      const userId = toBin(request.user.id);
      const hash = createHash('sha256')
        .update(`${request.method} ${request.routeOptions.url} ${request.url}\n`)
        .update(JSON.stringify(request.body ?? null))
        .digest('hex');

      try {
        await db.run(
          `INSERT INTO idempotency_keys (user_id, idem_key, request_hash, expires_at)
           VALUES (:userId, :key, :hash, DATE_ADD(NOW(3), INTERVAL :ttl HOUR))`,
          { userId, key, hash, ttl: TTL_HOURS },
        );
        request.idempotency = { userId, key };
        return;
      } catch (err) {
        if (err?.errno !== ER_DUP_ENTRY) throw err;
      }

      const row = await db.one(
        `SELECT request_hash, status_code, response_body FROM idempotency_keys
          WHERE user_id = :userId AND idem_key = :key AND expires_at > NOW(3)`,
        { userId, key },
      );
      if (!row) {
        // Süresi dolmuş kayıt: yenisiyle değiştir.
        await db.run('DELETE FROM idempotency_keys WHERE user_id = :userId AND idem_key = :key', {
          userId,
          key,
        });
        return idempotent.call(this, request, reply);
      }
      if (row.request_hash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED');
      if (row.status_code === null) {
        throw new AppError('CONFLICT', { details: { reason: 'request_in_progress' } });
      }
      reply.header('idempotent-replayed', 'true');
      reply.code(row.status_code).type('application/json; charset=utf-8');
      return reply.send(row.response_body);
    });

    app.addHook('onSend', async (request, reply, payload) => {
      const idem = request.idempotency;
      if (!idem) return payload;
      request.idempotency = null;
      const { db } = app.deps;
      if (reply.statusCode >= 500) {
        await db.run(
          'DELETE FROM idempotency_keys WHERE user_id = :userId AND idem_key = :key',
          idem,
        );
      } else {
        await db.run(
          `UPDATE idempotency_keys SET status_code = :status, response_body = :body
            WHERE user_id = :userId AND idem_key = :key`,
          { ...idem, status: reply.statusCode, body: typeof payload === 'string' ? payload : null },
        );
      }
      return payload;
    });
  },
  { name: 'idempotency', dependencies: ['auth'] },
);
