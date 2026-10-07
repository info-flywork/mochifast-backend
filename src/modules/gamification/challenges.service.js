import { DEFAULT_LOCALE } from '../../config/constants.js';
import { toApiEnum } from '../../shared/enums.js';
import { AppError } from '../../shared/errors.js';
import { fromBin, newId, toBin } from '../../shared/ids.js';
import { syncChallenges } from './gamification.repository.js';

const ER_DUP_ENTRY = 1062;
const DAY_MS = 86_400_000;

/**
 * Challenge'lar (docs/backend/04-api.md §13, 05 §13). Katılımcı sayısı gerçektir (şişirilmez).
 * Katılımcı avatarı için açık izin ayarı henüz yok: liste boş döner, istemci jenerik maskot
 * avatarlarını gösterir (05 §13).
 */
export function createChallengesService({ db, hasPremium = () => false }) {
  async function catalog(locale) {
    const rows = await db.many(
      `SELECT c.id, c.code, c.metric, c.target_count, c.duration_days, c.window_type, c.starts_at,
              c.ends_at, c.is_premium, c.is_featured, c.reward_xp, c.sort_order,
              t.title, t.subtitle, t.badge_label, t.description, t.locale,
              (SELECT COUNT(DISTINCT p.user_id) FROM challenge_participants p
                WHERE p.challenge_id = c.id AND p.status IN ('active', 'completed')) AS participants
         FROM challenges c
         JOIN challenge_translations t ON t.challenge_id = c.id AND t.locale IN (:locale, :fallback)
        WHERE c.is_active = 1
        ORDER BY c.sort_order, c.id`,
      { locale, fallback: DEFAULT_LOCALE },
    );
    // İstenen dil varsa o, yoksa İngilizce.
    const byId = new Map();
    for (const r of rows) {
      if (!byId.has(r.id) || r.locale === locale) byId.set(r.id, r);
    }
    return [...byId.values()];
  }

  async function mine(userId) {
    const rows = await db.many(
      `SELECT id, challenge_id, status, progress_count, window_start, window_end, completed_at
         FROM challenge_participants WHERE user_id = :userId
        ORDER BY created_at DESC`,
      { userId: toBin(userId) },
    );
    const latest = new Map();
    for (const r of rows) {
      const current = latest.get(r.challenge_id);
      // Aktif katılım öncelikli, yoksa en son katılım.
      if (!current || (r.status === 'active' && current.status !== 'active')) {
        latest.set(r.challenge_id, r);
      }
    }
    return latest;
  }

  function toDto(c, my) {
    return {
      code: c.code,
      title: c.title,
      subtitle: c.subtitle,
      badge: c.badge_label ?? null,
      description: c.description ?? null,
      metric: toApiEnum(c.metric),
      targetCount: c.target_count,
      durationDays: c.duration_days,
      windowType: c.window_type,
      startsAt: c.starts_at ? c.starts_at.toISOString() : null,
      endsAt: c.ends_at ? c.ends_at.toISOString() : null,
      rewardXp: c.reward_xp,
      isPremium: Boolean(c.is_premium),
      isFeatured: Boolean(c.is_featured),
      participantsCount: Number(c.participants),
      participantAvatars: [],
      my: my
        ? {
            id: fromBin(my.id),
            status: my.status,
            progress: my.progress_count,
            target: c.target_count,
            windowStart: my.window_start.toISOString(),
            windowEnd: my.window_end.toISOString(),
            completedAt: my.completed_at ? my.completed_at.toISOString() : null,
          }
        : null,
    };
  }

  async function one(userId, code, locale) {
    const c = (await catalog(locale)).find((x) => x.code === code);
    if (!c) throw new AppError('NOT_FOUND');
    return toDto(c, (await mine(userId)).get(c.id));
  }

  const service = {
    async list(userId, locale) {
      const [items, my] = await Promise.all([catalog(locale), mine(userId)]);
      return { items: items.map((c) => toDto(c, my.get(c.id))) };
    },

    /** Ana sayfa kartı: öne çıkan (yoksa ilk) challenge. */
    async featured(userId, locale) {
      const [items, my] = await Promise.all([catalog(locale), mine(userId)]);
      const c = items.find((x) => x.is_featured) ?? items[0];
      return { challenge: c ? toDto(c, my.get(c.id)) : null };
    },

    async join(userId, code, locale) {
      const c = (await catalog(locale)).find((x) => x.code === code);
      if (!c) throw new AppError('NOT_FOUND');
      if (c.is_premium && !hasPremium(userId)) {
        throw new AppError('PREMIUM_REQUIRED', { details: { challenge: code } });
      }
      const now = new Date();
      let windowStart = now;
      let windowEnd = new Date(now.getTime() + c.duration_days * DAY_MS);
      if (c.window_type === 'fixed') {
        if (now < c.starts_at || now > c.ends_at) {
          throw new AppError('CONFLICT', { details: { reason: 'challenge_not_open' } });
        }
        windowStart = c.starts_at;
        windowEnd = c.ends_at;
      }
      try {
        await db.withTransaction(async (conn) => {
          await db.one(
            'SELECT id FROM users WHERE id = :id FOR UPDATE',
            { id: toBin(userId) },
            conn,
          );
          await db.run(
            `INSERT INTO challenge_participants (id, challenge_id, user_id, window_start, window_end)
             VALUES (:id, :challengeId, :userId, :start, :end)`,
            {
              id: toBin(newId()),
              challengeId: c.id,
              userId: toBin(userId),
              start: windowStart,
              end: windowEnd,
            },
            conn,
          );
          // Sabit pencerede katılımdan önceki olaylar da sayılır.
          await syncChallenges(db, conn, userId, { now });
        });
      } catch (err) {
        if (err?.errno === ER_DUP_ENTRY) {
          throw new AppError('CONFLICT', { details: { reason: 'already_joined' } });
        }
        throw err;
      }
      return { challenge: await one(userId, code, locale) };
    },

    async leave(userId, code, locale) {
      const r = await db.run(
        `UPDATE challenge_participants p JOIN challenges c ON c.id = p.challenge_id
            SET p.status = 'left'
          WHERE p.user_id = :userId AND c.code = :code AND p.status = 'active'`,
        { userId: toBin(userId), code },
      );
      if (r.affectedRows === 0) throw new AppError('NOT_FOUND');
      return { challenge: await one(userId, code, locale) };
    },
  };
  return service;
}

/** Süresi dolan aktif katılımlar `failed` olur (saatlik iş). */
export async function expireChallenges(db, limit = 500) {
  let total = 0;
  for (;;) {
    const r = await db.run(
      `UPDATE challenge_participants SET status = 'failed'
        WHERE status = 'active' AND window_end < NOW(3) LIMIT :limit`,
      { limit: String(limit) },
    );
    total += r.affectedRows;
    if (r.affectedRows < limit) return total;
  }
}
