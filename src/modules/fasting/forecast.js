import { DateTime } from 'luxon';
import { fromBin, toBin } from '../../shared/ids.js';
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

/**
 * Bugünkü orucun saat saat zorluk eğrisi. Yalnızca gerçek kayıtlar:
 * zorlanma, fiziksel açlık check-in'i ve erken biten oruç.
 * Kayıt yoksa eğri düz ve tepe yoktur.
 * @returns curve  uzunluk = saat+1 (son nokta planın bitişi)
 */
export function forecastCurve({ fastMinutes, struggles = [], hungers = [], breaks = [] }) {
  const spanMinutes = Math.max(60, fastMinutes ?? 16 * 60);
  const hours = Math.max(1, Math.round(spanMinutes / 60));
  const struggle = Array(hours).fill(0);
  const hunger = Array(hours).fill(0);
  const broke = Array(hours).fill(0);

  const add = (bins, minutes, amount) => {
    const value = Number(minutes);
    if (!Number.isFinite(value) || amount <= 0) return;
    const index = Math.min(hours - 1, Math.max(0, Math.floor((value / spanMinutes) * hours)));
    bins[index] += amount;
  };
  for (const minutes of struggles) add(struggle, minutes, 1);
  for (const row of hungers) {
    add(hunger, row.fastedMinutes, Math.max(0, Number(row.physicalScore) || 0));
  }
  for (const minutes of breaks) add(broke, minutes, 1);

  const scale = (bins) => {
    const max = Math.max(0, ...bins);
    return max > 0 ? bins.map((v) => v / max) : bins.map(() => 0);
  };
  const s = scale(struggle);
  const g = scale(hunger);
  const b = scale(broke);
  const raw = s.map((v, i) => 0.45 * v + 0.35 * g[i] + 0.2 * b[i]);
  const peak = Math.max(0, ...raw);
  const values = peak > 0 ? raw.map((v) => Math.round((v / peak) * 100) / 100) : raw.map(() => 0);
  const curve = [...values, values.at(-1) ?? 0];
  const toughestElapsedHour = peak > 0 ? values.indexOf(Math.max(...values)) : null;

  let riskStartHour = null;
  let riskEndHour = null;
  if (toughestElapsedHour !== null) {
    const bar = Math.max(...values) * 0.7;
    let start = toughestElapsedHour;
    let end = toughestElapsedHour;
    while (start > 0 && values[start - 1] >= bar) start -= 1;
    while (end < values.length - 1 && values[end + 1] >= bar) end += 1;
    riskStartHour = start;
    riskEndHour = end + 1;
  }
  return { curve, toughestElapsedHour, riskStartHour, riskEndHour };
}

/**
 * Geçmiş orucun gün sınıfı.
 * Erken biten ya da aynı oruçta 2+ zorlanma: zor.
 * Hedefe ulaşmış ve zorlanma yok: kolay.
 * Kalanı orta.
 */
export function dayClass({ status, goalReached, struggles }) {
  if (status === 'ended_early' || struggles >= 2) return 'hard';
  if (goalReached && struggles === 0) return 'easy';
  return 'moderate';
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
      const [history, stats, sessions, struggles, hungers, active, plan, user] = await Promise.all([
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
          `SELECT id, status, goal_reached,
                  TIMESTAMPDIFF(MINUTE, started_at, ended_at) AS elapsed_minutes
             FROM fasting_sessions
            WHERE user_id = :id AND deleted_at IS NULL
              AND status IN ('completed', 'ended_early') AND ended_at IS NOT NULL
              AND ended_at >= DATE_SUB(:now, INTERVAL :days DAY)`,
          { id, now, days: FORECAST.struggleDays },
        ),
        db.many(
          `SELECT fasting_session_id, elapsed_minutes FROM struggle_events
            WHERE user_id = :id AND elapsed_minutes IS NOT NULL
              AND created_at >= DATE_SUB(:now, INTERVAL :days DAY)`,
          { id, now, days: FORECAST.struggleDays },
        ),
        db.many(
          `SELECT fasting_session_id, fasted_minutes, physical_score FROM hunger_checkins
            WHERE user_id = :id AND deleted_at IS NULL
              AND fasted_minutes IS NOT NULL AND physical_score > 0
              AND logged_at >= DATE_SUB(:now, INTERVAL :days DAY)`,
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
      const fastMinutes = fast
        ? Math.round((fast.endsAt.getTime() - fast.startsAt.getTime()) / 60_000)
        : (plan?.fast_minutes ?? null);
      const struggleCount = new Map();
      for (const row of struggles) {
        if (!row.fasting_session_id) continue;
        const key = fromBin(row.fasting_session_id);
        struggleCount.set(key, (struggleCount.get(key) ?? 0) + 1);
      }
      const classOf = new Map(
        sessions.map((s) => [
          fromBin(s.id),
          dayClass({
            status: s.status,
            goalReached: Boolean(s.goal_reached),
            struggles: struggleCount.get(fromBin(s.id)) ?? 0,
          }),
        ]),
      );
      const inputs = (name) => ({
        fastMinutes,
        struggles: struggles
          .filter(
            (r) =>
              !name ||
              (r.fasting_session_id && classOf.get(fromBin(r.fasting_session_id)) === name),
          )
          .map((r) => r.elapsed_minutes),
        hungers: hungers
          .filter(
            (r) =>
              !name ||
              (r.fasting_session_id && classOf.get(fromBin(r.fasting_session_id)) === name),
          )
          .map((r) => ({ fastedMinutes: r.fasted_minutes, physicalScore: r.physical_score })),
        breaks: sessions
          .filter(
            (s) => s.status === 'ended_early' && (!name || classOf.get(fromBin(s.id)) === name),
          )
          .map((s) => s.elapsed_minutes),
      });
      const shape = forecastCurve(inputs(null));
      const spanMs = fast ? fast.endsAt.getTime() - fast.startsAt.getTime() : 0;
      const clockOf = (curveShape, hour) => {
        if (!fast || hour === null || curveShape.curve.length < 2) return null;
        const fraction = hour / (curveShape.curve.length - 1);
        return new Date(fast.startsAt.getTime() + fraction * spanMs).toISOString();
      };
      const pack = (curveShape) => ({
        curve: curveShape.curve,
        toughestAt: clockOf(curveShape, curveShape.toughestElapsedHour),
        riskStartsAt: clockOf(curveShape, curveShape.riskStartHour),
        riskEndsAt: clockOf(curveShape, curveShape.riskEndHour),
      });
      const days = {
        easy: pack(forecastCurve(inputs('easy'))),
        moderate: pack(forecastCurve(inputs('moderate'))),
        hard: pack(forecastCurve(inputs('hard'))),
      };
      return {
        forecast: {
          ...result,
          toughestElapsedHour: shape.toughestElapsedHour,
          curve: shape.curve,
          fast: fast && {
            active: fast.active,
            startsAt: fast.startsAt.toISOString(),
            endsAt: fast.endsAt.toISOString(),
          },
          toughestAt: clockOf(shape, shape.toughestElapsedHour),
          riskStartsAt: clockOf(shape, shape.riskStartHour),
          riskEndsAt: clockOf(shape, shape.riskEndHour),
          days,
        },
      };
    },
  };
}
