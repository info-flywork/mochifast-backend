import { sessionCachePrefix } from '../../plugins/auth.js';
import { AppError } from '../../shared/errors.js';
import { fromBin, toBin } from '../../shared/ids.js';
import { revokeUserSessions } from '../auth/auth.repository.js';
import { maskEmail, maskName } from './admin.permissions.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_LIMIT = 20;

/** RevenueCat promosyon süreleri (11 §5). */
export const PROMO_DURATIONS = Object.freeze([
  'daily',
  'three_day',
  'weekly',
  'monthly',
  'two_month',
  'three_month',
  'six_month',
  'yearly',
  'lifetime',
]);

const USER_COLUMNS = `u.id, u.status, u.is_guest, u.display_name, u.email, u.locale, u.timezone,
                      u.onboarding_completed_at, u.last_active_at, u.created_at`;

function userSummary(r) {
  return {
    id: fromBin(r.id),
    status: r.status,
    isGuest: Boolean(r.is_guest),
    name: maskName(r.display_name),
    email: maskEmail(r.email),
    locale: r.locale,
    timezone: r.timezone,
    onboarded: r.onboarding_completed_at !== null,
    lastActiveAt: r.last_active_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Destek: kullanıcı arama (PII maskeli) ve işlemler (04 §19). Ham sağlık verisi gösterilmez.
 * Her işlem gerekçesiyle `audit_logs`'a yazılır.
 */
export function createAdminSupport({ db, cache, entitlements, billing, audit }) {
  async function mustFind(id) {
    if (!UUID.test(id)) throw new AppError('NOT_FOUND');
    const row = await db.one(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = :id`, {
      id: toBin(id),
    });
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  return {
    /** `q`: kullanıcı kimliği (UUID) ya da tam e-posta. Kısmi arama yok (PII taraması önlenir). */
    async search(q, meta, adminId) {
      const query = q.trim();
      const rows = UUID.test(query)
        ? await db.many(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = :id`, {
            id: toBin(query),
          })
        : await db.many(
            `SELECT ${USER_COLUMNS} FROM users u
              WHERE u.email = :email
                 OR EXISTS (SELECT 1 FROM auth_identities ai
                             WHERE ai.user_id = u.id AND ai.email = :email)
              ORDER BY u.created_at DESC LIMIT :limit`,
            { email: query.toLowerCase(), limit: String(SEARCH_LIMIT) },
          );
      await audit(meta, 'admin.user.search', adminId, {
        metadata: { by: UUID.test(query) ? 'id' : 'email', results: rows.length },
      });
      return { items: rows.map(userSummary) };
    },

    async detail(id, meta, adminId) {
      const row = await mustFind(id);
      const bin = toBin(id);
      const [devices, sessions, subscription, deletion, consents, stats] = await Promise.all([
        db.many(
          `SELECT platform, app_version, os_version, device_model, push_token IS NOT NULL AS push,
                  last_seen_at
             FROM devices WHERE user_id = :id ORDER BY last_seen_at DESC`,
          { id: bin },
        ),
        db.one(
          `SELECT COUNT(*) AS n FROM sessions
            WHERE user_id = :id AND (revoke_reason IS NULL OR revoke_reason = 'rotated')
              AND expires_at > NOW(3)`,
          { id: bin },
        ),
        db.one(
          `SELECT store, product_id, status, period_type, will_renew, expires_at
             FROM subscriptions WHERE user_id = :id LIMIT 1`,
          { id: bin },
        ),
        db.one(
          `SELECT source, status, requested_at, scheduled_for FROM account_deletion_requests
            WHERE user_id = :id ORDER BY requested_at DESC LIMIT 1`,
          { id: bin },
        ),
        db.many(
          `SELECT c.consent_type, c.granted, c.document_version, c.created_at
             FROM user_consents c
             JOIN (SELECT consent_type, MAX(created_at) AS at FROM user_consents
                    WHERE user_id = :id GROUP BY consent_type) l
               ON l.consent_type = c.consent_type AND l.at = c.created_at
            WHERE c.user_id = :id`,
          { id: bin },
        ),
        db.one(
          'SELECT level, xp, current_streak, completed_fasts FROM user_stats WHERE user_id = :id',
          {
            id: bin,
          },
        ),
      ]);
      await audit(meta, 'admin.user.view', adminId, { entityType: 'user', entityId: id });
      return {
        user: {
          ...userSummary(row),
          isPremium: await entitlements.isPremium(id),
          devices: devices.map((d) => ({
            platform: d.platform,
            appVersion: d.app_version,
            osVersion: d.os_version,
            deviceModel: d.device_model,
            push: Boolean(d.push),
            lastSeenAt: d.last_seen_at?.toISOString() ?? null,
          })),
          activeSessions: Number(sessions.n),
          subscription: subscription && {
            store: subscription.store,
            productId: subscription.product_id,
            status: subscription.status,
            periodType: subscription.period_type,
            willRenew: Boolean(subscription.will_renew),
            expiresAt: subscription.expires_at?.toISOString() ?? null,
          },
          deletion: deletion && {
            source: deletion.source,
            status: deletion.status,
            requestedAt: deletion.requested_at.toISOString(),
            scheduledFor: deletion.scheduled_for.toISOString(),
          },
          consents: consents.map((c) => ({
            type: c.consent_type,
            granted: Boolean(c.granted),
            version: c.document_version,
            at: c.created_at.toISOString(),
          })),
          stats: stats && {
            level: stats.level,
            xp: stats.xp,
            currentStreak: stats.current_streak,
            completedFasts: stats.completed_fasts,
          },
        },
      };
    },

    /** Tüm oturumları sonlandırır (çalınan cihaz, hesap paylaşımı). */
    async revokeSessions(id, { reason }, meta, adminId) {
      await mustFind(id);
      await db.withTransaction((conn) => revokeUserSessions(db, conn, id, 'admin'));
      await cache.delPrefix(sessionCachePrefix(id));
      await audit(meta, 'admin.user.sessions_revoked', adminId, {
        entityType: 'user',
        entityId: id,
        metadata: { reason },
      });
      return {};
    },

    /** Süreli promosyon premium (RevenueCat) + anında senkron. */
    async grantPremium(id, { duration, reason }, meta, adminId) {
      await mustFind(id);
      const result = await billing.grantPromotional(id, duration, { actorId: adminId });
      await audit(meta, 'admin.user.premium_granted', adminId, {
        entityType: 'user',
        entityId: id,
        metadata: { duration, reason },
      });
      return { isPremium: Boolean(result.after) };
    },

    /** Bekleyen silme talebini şimdiye çeker; sonraki süpürmede (≤ 1 sa) silinir. */
    async expediteDeletion(id, { reason }, meta, adminId) {
      await mustFind(id);
      const r = await db.run(
        `UPDATE account_deletion_requests SET scheduled_for = NOW(3)
          WHERE user_id = :id AND status = 'scheduled'`,
        { id: toBin(id) },
      );
      if (r.affectedRows === 0) {
        throw new AppError('CONFLICT', { details: { reason: 'no_pending_deletion' } });
      }
      await audit(meta, 'admin.user.deletion_expedited', adminId, {
        entityType: 'user',
        entityId: id,
        metadata: { reason },
      });
      return {};
    },
  };
}
