import fp from 'fastify-plugin';
import { AppError } from '../shared/errors.js';
import { toBin } from '../shared/ids.js';

const SESSION_CACHE_TTL_SEC = 60;
/** `users.last_active_at` en fazla bu aralıkla yazılır (misafir saklama süresi, 06 §8.4). */
const ACTIVITY_TOUCH_SEC = 3_600;

/** Bir kullanıcının oturum cache kayıtlarının öneki; iptalde `cache.delPrefix` ile silinir. */
export function sessionCachePrefix(userId) {
  return `sess:${userId}:`;
}

/**
 * Access token doğrulama (docs/backend/06-guvenlik.md §2.2).
 *
 * Route'larda:
 *   { preHandler: app.requireAuth }    token zorunlu → request.user
 *   { preHandler: app.optionalAuth }   token varsa doğrular (geçersizse hata), yoksa request.user = null
 *
 * İmza + süre kontrolünden sonra oturum (`sid`) ve kullanıcı durumu kontrol edilir. Sonuç process
 * içi cache'te 60 sn tutulur; iptal (çıkış, yeniden kullanım, hesap değişimi) kaydı hemen siler.
 * "rotated" oturum geçerli sayılır: yenilemeden önce verilmiş access token'lar süreleri dolana
 * kadar çalışır (aile iptal edilirse hepsi reddedilir).
 */
export default fp(
  async function auth(app) {
    app.decorateRequest('user', null);

    async function loadSession(userId, sessionId) {
      const row = await app.deps.db.one(
        `SELECT s.revoke_reason, s.expires_at > NOW(3) AS live, u.status, u.is_guest
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = :sid AND s.user_id = :uid`,
        { sid: toBin(sessionId), uid: toBin(userId) },
      );
      if (!row) return { active: false, status: null, isGuest: false };
      const usable = row.revoke_reason === null || row.revoke_reason === 'rotated';
      return { active: Boolean(row.live) && usable, status: row.status, isGuest: row.is_guest };
    }

    async function authenticate(request) {
      const header = request.headers.authorization;
      const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
      if (!match) throw new AppError('UNAUTHENTICATED', { message: 'Bearer token yok' });

      const { userId, sessionId } = await app.deps.tokens.verifyAccess(match[1]);
      const session = await app.deps.cache.getOrSet(
        `${sessionCachePrefix(userId)}${sessionId}`,
        SESSION_CACHE_TTL_SEC,
        () => loadSession(userId, sessionId),
      );
      if (session.status === 'banned') throw new AppError('FORBIDDEN');
      if (session.status === 'pending_deletion' || session.status === 'deleted') {
        throw new AppError('GONE');
      }
      if (!session.active) throw new AppError('UNAUTHENTICATED', { message: 'oturum geçersiz' });

      request.user = { id: userId, sessionId, isGuest: session.isGuest };
      await touchActivity(request, userId);
    }

    /** Son etkinlik; yanıtı bekletmez, `updated_at`'i değiştirmez. */
    async function touchActivity(request, userId) {
      const key = `active:${userId}`;
      if ((await app.deps.cache.get(key)) !== null) return;
      await app.deps.cache.set(key, 1, ACTIVITY_TOUCH_SEC);
      app.deps.db
        .run('UPDATE users SET last_active_at = NOW(3), updated_at = updated_at WHERE id = :id', {
          id: toBin(userId),
        })
        .catch((err) => request.log.warn({ err }, 'last_active_at yazılamadı'));
    }

    app.decorate('requireAuth', async function requireAuth(request) {
      await authenticate(request);
    });

    app.decorate('optionalAuth', async function optionalAuth(request) {
      if (request.headers.authorization === undefined) return;
      await authenticate(request);
    });
  },
  { name: 'auth', dependencies: ['request-context'] },
);
