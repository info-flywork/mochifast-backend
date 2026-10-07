import { DateTime } from 'luxon';
import { toBin } from '../../shared/ids.js';
import { isValidTimezone } from '../../shared/time.js';

/**
 * Fast Forecast v0 (`GET /v1/fasts/forecast`): bugünkü orucun başarı tahmini, bitiş zamanı ve
 * en zor saat. Model yok; kullanıcının kendi geçmişinden basit, açıklanabilir istatistik.
 */
export const FORECAST = Object.freeze({
  /** Tamamlama oranı penceresi (gün) ve en az biten oruç sayısı. */
  historyDays: 14,
  minEndedFasts: 3,
  /** Zorlanma saatleri penceresi (gün) ve en az olay. */
  struggleDays: 30,
  minStruggles: 3,
  /** Seri bonusu: gün başına +%1, en çok 7. */
  streakBonusPerDay: 0.01,
  streakBonusMaxDays: 7,
  minChance: 0.05,
  maxChance: 0.97,
});

/**
 * Saf hesap (test edilebilir).
 * @param input.ended    son N günde biten (tamamlanan + erken biten) oruç sayısı
 * @param input.reached  bunlardan hedefe ulaşan
 * @param input.streak   güncel seri (gün)
 * @param input.struggleElapsed zorlanma anlarındaki oruç süreleri (dk)
 */
export function forecastStats({ ended, reached, streak, struggleElapsed }) {
  if (ended < FORECAST.minEndedFasts) return { available: false };
  // Laplace düzeltmesi: az veride %0/%100'e saplanmaz.
  const base = (reached + 1) / (ended + 2);
  const bonus = Math.min(streak, FORECAST.streakBonusMaxDays) * FORECAST.streakBonusPerDay;
  const chance = Math.min(FORECAST.maxChance, Math.max(FORECAST.minChance, base + bonus));

  let toughestHour = null;
  if (struggleElapsed.length >= FORECAST.minStruggles) {
    const counts = new Map();
    for (const minutes of struggleElapsed) {
      const hour = Math.floor(minutes / 60);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    // En sık saat; eşitlikte daha erken saat (önce gelen zorluk).
    toughestHour = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  }
  return {
    available: true,
    successChance: Math.round(chance * 100) / 100,
    basedOnFasts: ended,
    toughestElapsedHour: toughestHour,
  };
}

/** Aktif oruç ya da plana göre bugünün (sıradaki) orucu: başlangıç ve bitiş. */
export function upcomingFast({ active, plan, timezone, now = new Date() }) {
  if (active) {
    return { active: true, startsAt: active.startedAt, endsAt: active.plannedEndAt };
  }
  if (!plan?.fastMinutes || !plan.eatWindowEnd) return null;
  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  const [h, m] = plan.eatWindowEnd.split(':').map(Number);
  let start = DateTime.fromJSDate(now, { zone: tz }).set({
    hour: h,
    minute: m,
    second: 0,
    millisecond: 0,
  });
  if (start.toJSDate() < now) start = start.plus({ days: 1 });
  const startsAt = start.toJSDate();
  return {
    active: false,
    startsAt,
    endsAt: new Date(startsAt.getTime() + plan.fastMinutes * 60_000),
  };
}

export function createForecastService({ db }) {
  return {
    async forecast(userId, now = new Date()) {
      const id = toBin(userId);
      const [history, stats, struggles, active, plan, user] = await Promise.all([
        db.one(
          `SELECT COUNT(*) AS ended, COALESCE(SUM(goal_reached), 0) AS reached
             FROM fasting_sessions
            WHERE user_id = :id AND deleted_at IS NULL
              AND status IN ('completed', 'ended_early')
              AND ended_at >= DATE_SUB(:now, INTERVAL :days DAY)`,
          { id, now, days: FORECAST.historyDays },
        ),
        db.one('SELECT current_streak FROM user_stats WHERE user_id = :id', { id }),
        db.many(
          `SELECT elapsed_minutes FROM struggle_events
            WHERE user_id = :id AND elapsed_minutes IS NOT NULL
              AND created_at >= DATE_SUB(:now, INTERVAL :days DAY)`,
          { id, now, days: FORECAST.struggleDays },
        ),
        db.one(
          `SELECT started_at, planned_end_at FROM fasting_sessions
            WHERE user_id = :id AND status = 'active' AND deleted_at IS NULL`,
          { id },
        ),
        db.one(
          `SELECT fast_minutes, TIME_FORMAT(eat_window_end, '%H:%i') AS eat_end FROM user_plans
            WHERE user_id = :id AND ended_at IS NULL ORDER BY started_on DESC LIMIT 1`,
          { id },
        ),
        db.one('SELECT timezone FROM users WHERE id = :id', { id }),
      ]);

      const result = forecastStats({
        ended: Number(history.ended),
        reached: Number(history.reached),
        streak: stats?.current_streak ?? 0,
        struggleElapsed: struggles.map((r) => r.elapsed_minutes),
      });
      if (!result.available) return { forecast: { available: false } };

      const fast = upcomingFast({
        active: active && { startedAt: active.started_at, plannedEndAt: active.planned_end_at },
        plan: plan && { fastMinutes: plan.fast_minutes, eatWindowEnd: plan.eat_end },
        timezone: user?.timezone,
        now,
      });
      const toughestAt =
        fast && result.toughestElapsedHour !== null
          ? new Date(fast.startsAt.getTime() + result.toughestElapsedHour * 3_600_000)
          : null;
      return {
        forecast: {
          ...result,
          fast: fast && {
            active: fast.active,
            startsAt: fast.startsAt.toISOString(),
            endsAt: fast.endsAt.toISOString(),
          },
          toughestAt: toughestAt?.toISOString() ?? null,
        },
      };
    },
  };
}
