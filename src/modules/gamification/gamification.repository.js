import { fromBin, toBin } from '../../shared/ids.js';
import { isValidTimezone, localDate } from '../../shared/time.js';
import { ZONES, zoneState } from './world.rules.js';

const THRESHOLD_TTL_MS = 5 * 60_000;
let thresholdCache = { at: 0, value: null };

/** Bölge eşikleri; nadiren değişir, 5 dk process içinde tutulur. */
export async function zoneThresholds(db, conn) {
  if (thresholdCache.value && Date.now() - thresholdCache.at < THRESHOLD_TTL_MS) {
    return thresholdCache.value;
  }
  const rows = await db.many(
    'SELECT zone, level, threshold FROM world_zone_thresholds ORDER BY zone, level',
    {},
    conn,
  );
  const value = {};
  for (const r of rows) (value[r.zone] ??= []).push(Number(r.threshold));
  thresholdCache = { at: Date.now(), value };
  return value;
}

/** Testler için (seed sonrası eşikler değişebilir). */
export function resetThresholdCache() {
  thresholdCache = { at: 0, value: null };
}

/** Bölge metrikleri ve ulaşılan en yüksek seviyeler. */
async function worldInputs(db, conn, userId) {
  const [thresholds, stats, rows] = await Promise.all([
    zoneThresholds(db, conn),
    db.one(
      `SELECT completed_fasts, water_goal_days, meals_logged, best_weight_lost_kg, world_health
         FROM user_stats WHERE user_id = :userId`,
      { userId: toBin(userId) },
      conn,
    ),
    db.many(
      'SELECT zone, max_level_reached FROM user_world_zones WHERE user_id = :userId',
      { userId: toBin(userId) },
      conn,
    ),
  ]);
  const reached = Object.fromEntries(rows.map((r) => [r.zone, r.max_level_reached]));
  return { thresholds, stats, reached };
}

/**
 * Bölge durumları. Ada geri gitmez: gösterilen seviye ulaşılan en yüksek seviyedir; metrik
 * gerilediyse sonraki eşik gösterilen seviyeden hesaplanır.
 */
export function computeZones({ thresholds, stats, reached }) {
  return ZONES.map((z) => {
    const list = thresholds[z.zone] ?? [];
    const current = Number(stats?.[z.stat] ?? 0);
    const state = zoneState(current, list);
    const before = reached[z.zone] ?? 0;
    const level = Math.max(before, state.level);
    const shown =
      level > state.level
        ? { nextThreshold: list[level] ?? null, ratioToNext: 0 }
        : { nextThreshold: state.nextThreshold, ratioToNext: state.ratioToNext };
    return { ...z, current, level, computedLevel: state.level, before, thresholds: list, ...shown };
  });
}

/** Okuma (GET /world): yazma yapmaz. */
export async function readWorld(db, userId) {
  const inputs = await worldInputs(db, undefined, userId);
  return { zones: computeZones(inputs), health: inputs.stats?.world_health ?? 'thriving' };
}

/**
 * Bölge değerlerini `user_stats`'tan günceller; seviye yükseldiyse kaydeder ve döner.
 * Çağıran kullanıcı satırını kilitlemiş olmalıdır.
 * @returns {levelUps: [{zone, from, to}], zones}
 */
export async function syncWorld(db, conn, userId) {
  const zones = computeZones(await worldInputs(db, conn, userId));
  const levelUps = [];
  for (const z of zones) {
    if (z.computedLevel > z.before)
      levelUps.push({ zone: z.zone, from: z.before, to: z.computedLevel });
    await db.run(
      `INSERT INTO user_world_zones (user_id, zone, current_value, max_level_reached)
       VALUES (:userId, :zone, :value, :level)
       ON DUPLICATE KEY UPDATE current_value = VALUES(current_value),
         max_level_reached = GREATEST(max_level_reached, VALUES(max_level_reached))`,
      { userId: toBin(userId), zone: z.zone, value: z.current, level: z.level },
      conn,
    );
  }
  return { levelUps, zones };
}

// ── Challenge'lar ─────────────────────────────────────────────────────

const PARTICIPANT_COLUMNS = `p.id, p.challenge_id, p.window_start, p.window_end, p.progress_count,
  p.status, p.completed_at, c.code, c.metric, c.target_count, c.reward_xp`;

const toParticipant = (r) => ({
  id: fromBin(r.id),
  challengeId: r.challenge_id,
  code: r.code,
  metric: r.metric,
  target: r.target_count,
  rewardXp: r.reward_xp,
  windowStart: r.window_start,
  windowEnd: r.window_end,
  progress: r.progress_count,
  status: r.status,
  completedAt: r.completed_at ?? null,
});

export async function activeParticipations(db, conn, userId) {
  const rows = await db.many(
    `SELECT ${PARTICIPANT_COLUMNS}
       FROM challenge_participants p JOIN challenges c ON c.id = p.challenge_id
      WHERE p.user_id = :userId AND p.status = 'active'`,
    { userId: toBin(userId) },
    conn,
  );
  return rows.map(toParticipant);
}

/**
 * Penceredeki olay sayısı (05 §13). Pencerenin geleceğe taşan kısmı sayılmaz.
 * Silinen kayıt sayılmaz: her senkronda baştan sayılır.
 */
async function countInWindow(db, conn, userId, p, { now, tz }) {
  const end = p.windowEnd < now ? p.windowEnd : now;
  const params = { userId: toBin(userId), from: p.windowStart, to: end };
  switch (p.metric) {
    case 'meals_logged':
      return (
        await db.one(
          `SELECT COUNT(*) AS n FROM meals WHERE user_id = :userId AND deleted_at IS NULL
              AND eaten_at BETWEEN :from AND :to`,
          params,
          conn,
        )
      ).n;
    case 'fasts_completed':
      return (
        await db.one(
          `SELECT COUNT(*) AS n FROM fasting_sessions WHERE user_id = :userId
              AND deleted_at IS NULL AND status = 'completed' AND ended_at BETWEEN :from AND :to`,
          params,
          conn,
        )
      ).n;
    case 'hunger_checkins':
      return (
        await db.one(
          `SELECT COUNT(*) AS n FROM hunger_checkins WHERE user_id = :userId
              AND deleted_at IS NULL AND logged_at BETWEEN :from AND :to`,
          params,
          conn,
        )
      ).n;
    case 'water_goal_days':
      return (
        await db.one(
          `SELECT COUNT(*) AS n FROM daily_summaries WHERE user_id = :userId
              AND local_date BETWEEN :fromDay AND :toDay
              AND water_goal_ml IS NOT NULL AND water_ml >= water_goal_ml`,
          {
            userId: toBin(userId),
            fromDay: localDate(p.windowStart, tz),
            toDay: localDate(end, tz),
          },
          conn,
        )
      ).n;
    case 'streak_days': {
      // Pencere içindeki seri: güncel seri, pencerenin geçen gün sayısıyla sınırlı.
      const row = await db.one(
        'SELECT current_streak FROM user_stats WHERE user_id = :userId',
        params,
        conn,
      );
      const days = Math.floor((end - p.windowStart) / 86_400_000) + 1;
      return Math.min(row?.current_streak ?? 0, days);
    }
    default:
      return 0;
  }
}

/**
 * Aktif katılımların ilerlemesini günceller; hedefe ulaşan `completed` olur ve XP olayı yazılır
 * (`challenge_completed`, ref = katılım id'si; tekrar yazılmaz). Çağıran kullanıcı satırını
 * kilitlemiş olmalıdır.
 * @returns [{code, progress, target, status}]
 */
export async function syncChallenges(db, conn, userId, { now = new Date(), tz } = {}) {
  const active = await activeParticipations(db, conn, userId);
  if (active.length === 0) return [];
  let zone = tz;
  if (!zone) {
    const u = await db.one(
      'SELECT timezone FROM users WHERE id = :id',
      { id: toBin(userId) },
      conn,
    );
    zone = isValidTimezone(u?.timezone) ? u.timezone : 'UTC';
  }
  const out = [];
  for (const p of active) {
    const progress = Math.min(
      Number(await countInWindow(db, conn, userId, p, { now, tz: zone })),
      65_535,
    );
    const done = progress >= p.target && now <= p.windowEnd;
    await db.run(
      `UPDATE challenge_participants
          SET progress_count = :progress,
              status = IF(:done, 'completed', status),
              completed_at = IF(:done, :now, completed_at)
        WHERE id = :id`,
      { id: toBin(p.id), progress, done: done ? 1 : 0, now },
      conn,
    );
    if (done) {
      await db.run(
        `INSERT IGNORE INTO xp_events (user_id, reason, ref_key, amount, local_date)
         VALUES (:userId, 'challenge_completed', :ref, :amount, :day)`,
        { userId: toBin(userId), ref: p.id, amount: p.rewardXp, day: localDate(now, zone) },
        conn,
      );
    }
    out.push({ code: p.code, progress, target: p.target, status: done ? 'completed' : 'active' });
  }
  return out;
}
