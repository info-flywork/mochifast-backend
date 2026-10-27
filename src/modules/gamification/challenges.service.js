import { DEFAULT_LOCALE } from '../../config/constants.js';
import { toApiEnum } from '../../shared/enums.js';
import { AppError } from '../../shared/errors.js';
import { fromBin, newId, toBin } from '../../shared/ids.js';
import { syncChallenges } from './gamification.repository.js';

const ER_DUP_ENTRY = 1062;
const DAY_MS = 86_400_000;

const PARTICIPANTS_LIMIT = 50;
const CATALOG_TTL_SEC = 60;
const PREVIEW_AVATARS = 3;

/** "Ayşe Yılmaz" → "Ayşe Y." — rızalı kullanıcıda bile soyadı tam gösterilmez. */
export function shortName(displayName) {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts.at(-1)[0].toLocaleUpperCase()}.`;
}

/**
 * Challenge'lar (docs/backend/04-api.md §13, 05 §13). Katılımcı sayısı gerçektir (şişirilmez).
 * Ad + avatar yalnızca `user_settings.show_in_challenges` açık olanlarda döner; diğerleri
 * listede anonimdir (istemci maskot gösterir). Kullanıcı kendini her zaman görür.
 */
export function createChallengesService({
  db,
  cache = null,
  hasPremium = async () => false,
  avatarUrls = async () => new Map(),
}) {
  /** Challenge tanımları + çeviriler (seed/admin ile değişir; 60 sn bellekte). */
  async function loadCatalog(locale) {
    const rows = await db.many(
      `SELECT c.id, c.code, c.metric, c.target_count, c.duration_days, c.window_type, c.starts_at,
              c.ends_at, c.is_premium, c.is_featured, c.reward_xp, c.sort_order,
              t.title, t.subtitle, t.badge_label, t.description, t.locale
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
  const catalog = (locale) =>
    cache
      ? cache.getOrSet(`challenges:catalog:${locale}`, CATALOG_TTL_SEC, () => loadCatalog(locale))
      : loadCatalog(locale);

  async function findChallenge(code, locale) {
    const c = (await catalog(locale)).find((x) => x.code === code);
    if (!c) throw new AppError('NOT_FOUND');
    return c;
  }

  /** Gerçek katılımcı sayıları (aktif + tamamlayan, kişi başına bir): `Map<challengeId, n>`. */
  async function counts(challengeId = null) {
    const rows = await db.many(
      `SELECT challenge_id, COUNT(DISTINCT user_id) AS n
         FROM challenge_participants
        WHERE status IN ('active', 'completed')
          ${challengeId === null ? '' : 'AND challenge_id = :challengeId'}
        GROUP BY challenge_id`,
      challengeId === null ? {} : { challengeId },
    );
    return new Map(rows.map((r) => [r.challenge_id, Number(r.n)]));
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

  /** Katılımcılar (aktif + tamamlayan), ilerlemeye göre sıralı; kişi başına en iyi katılım. */
  async function participantRows(challengeId, { publicOnly = false, limit = PARTICIPANTS_LIMIT }) {
    const rows = await db.many(
      `SELECT p.user_id, p.status, p.progress_count, p.completed_at, p.created_at,
              u.display_name, COALESCE(s.show_in_challenges, 0) AS is_public
         FROM challenge_participants p
         JOIN users u ON u.id = p.user_id AND u.status = 'active'
         LEFT JOIN user_settings s ON s.user_id = p.user_id
        WHERE p.challenge_id = :challengeId AND p.status IN ('active', 'completed')
          ${publicOnly ? 'AND s.show_in_challenges = 1' : ''}
        ORDER BY p.status = 'completed' DESC, p.progress_count DESC,
                 COALESCE(p.completed_at, p.created_at) ASC
        LIMIT :limit`,
      { challengeId, limit: String(limit * 2) },
    );
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const id = fromBin(r.user_id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...r, userId: id, isPublic: Boolean(r.is_public) });
      if (out.length === limit) break;
    }
    return out;
  }

  /** Ana sayfa kartı için rızalı ilk birkaç katılımcının avatarı. */
  async function previewAvatars(challengeId) {
    const rows = await participantRows(challengeId, { publicOnly: true, limit: 12 });
    const urls = await avatarUrls(rows.map((r) => r.userId));
    return rows
      .map((r) => urls.get(r.userId))
      .filter(Boolean)
      .slice(0, PREVIEW_AVATARS);
  }

  function toDto(c, my, { count = 0, avatars = [] } = {}) {
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
      participantsCount: count,
      participantAvatars: avatars,
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
    const c = await findChallenge(code, locale);
    const [my, n, avatars] = await Promise.all([mine(userId), counts(c.id), previewAvatars(c.id)]);
    return toDto(c, my.get(c.id), { count: n.get(c.id) ?? 0, avatars });
  }

  const service = {
    async list(userId, locale) {
      const [items, my, n] = await Promise.all([catalog(locale), mine(userId), counts()]);
      return { items: items.map((c) => toDto(c, my.get(c.id), { count: n.get(c.id) ?? 0 })) };
    },

    /** Ana sayfa kartı: öne çıkan (yoksa ilk) challenge. */
    async featured(userId, locale) {
      const [items, my] = await Promise.all([catalog(locale), mine(userId)]);
      const c = items.find((x) => x.is_featured) ?? items[0];
      if (!c) return { challenge: null };
      const [n, avatars] = await Promise.all([counts(c.id), previewAvatars(c.id)]);
      return { challenge: toDto(c, my.get(c.id), { count: n.get(c.id) ?? 0, avatars }) };
    },

    /** Challenge detayı (sayfa). */
    async get(userId, code, locale) {
      return { challenge: await one(userId, code, locale) };
    },

    /**
     * Katılımcı listesi (en fazla 50, ilerlemeye göre). Rızası olmayanın adı/avatarı dönmez;
     * kullanıcı kendi satırını her zaman ad + avatarla görür. Kullanıcı kimliği dönmez.
     */
    async participants(userId, code, locale) {
      const c = await findChallenge(code, locale);
      const [rows, n] = await Promise.all([participantRows(c.id, {}), counts(c.id)]);
      const shown = rows.filter((r) => r.isPublic || r.userId === userId).map((r) => r.userId);
      const urls = await avatarUrls(shown);
      return {
        total: n.get(c.id) ?? 0,
        items: rows.map((r, i) => {
          const isMe = r.userId === userId;
          const visible = r.isPublic || isMe;
          return {
            rank: i + 1,
            isMe,
            displayName: visible ? shortName(r.display_name) : null,
            avatarUrl: visible ? (urls.get(r.userId) ?? null) : null,
            progress: r.progress_count,
            target: c.target_count,
            status: r.status,
            completedAt: r.completed_at ? r.completed_at.toISOString() : null,
          };
        }),
      };
    },

    async join(userId, code, locale) {
      const c = await findChallenge(code, locale);
      if (c.is_premium && !(await hasPremium(userId))) {
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
