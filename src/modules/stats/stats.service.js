import { addDays, isValidTimezone, isoDate, localDate, mondayOf } from '../../shared/time.js';
import * as fastingRepo from '../fasting/fasting.repository.js';
import * as repo from './stats.repository.js';
import {
  FAST_GOAL_BONUS_XP,
  FAST_XP,
  GOAL_BONUS_MAX_TARGET,
  MIN_COUNTED_FAST_MINUTES,
  computeStreaks,
  dayKept,
  dayResolver,
  levelFor,
  levelProgress,
} from './stats.rules.js';

const XP_RULES = Object.freeze({
  minMinutes: MIN_COUNTED_FAST_MINUTES,
  fastXp: FAST_XP,
  bonusXp: FAST_GOAL_BONUS_XP,
  bonusMaxTarget: GOAL_BONUS_MAX_TARGET,
});

/** range → gün sayısı (null = tüm geçmiş). */
const RANGE_DAYS = Object.freeze({ week: 7, month: 30, year: 365, all: null });

const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);
const minDate = (...dates) => dates.filter(Boolean).sort()[0] ?? null;

/**
 * Türetilmiş veriler: günlük özetler, seri, sayaçlar, XP (docs/backend/05-is-kurallari.md §14).
 * Hepsi ham tablolardan deterministik olarak yeniden üretilir; yazmalar kullanıcı satırı
 * kilitliyken yapılır (aynı kullanıcının eşzamanlı yeniden hesaplamaları sıraya girer).
 */
export function createStatsService({ db }) {
  async function zoneOf(userId, conn, options) {
    const tz = await repo.userTimezone(db, userId, conn, options);
    return isValidTimezone(tz) ? tz : 'UTC';
  }

  async function recomputeIn(conn, userId, { from, now, lock, tz: knownTz }) {
    const tz = knownTz && !lock ? knownTz : await zoneOf(userId, conn, { lock });
    const today = localDate(now, tz);
    const before = await repo.getStats(db, userId, conn);
    const plans = await repo.planHistory(db, userId, conn);
    const resolveDay = dayResolver(plans);

    await repo.rebuildFastingDays(db, conn, userId, from, resolveDay);
    await repo.rebuildFastXp(db, conn, userId, from, XP_RULES);

    // Tarih sıralı: ilk anahtar, ilk oruç günüdür (plan yoksa serinin başlangıç sınırı).
    const { fasted, checkins } = await repo.streakInputs(db, userId, conn);
    const streak = computeStreaks({
      firstDay: minDate(plans[0]?.startedOn, fasted.keys().next().value),
      today,
      resolveDay,
      fasted,
      checkins,
    });
    await repo.insertMilestoneXp(db, conn, userId, streak.milestones);
    await repo.rebuildDailyXp(db, conn, userId);

    const totals = await repo.totals(db, conn, userId, MIN_COUNTED_FAST_MINUTES);
    const level = levelFor(totals.xp);
    await repo.saveStats(db, conn, userId, {
      ...totals,
      current: streak.current,
      best: streak.best,
      today,
      level,
    });
    return {
      before: {
        streak: before?.current_streak ?? 0,
        xp: before?.xp ?? 0,
        level: before?.level ?? 1,
      },
      after: { streak: streak.current, best: streak.best, xp: totals.xp, level },
    };
  }

  const service = {
    /**
     * `from` gününden itibaren yeniden hesaplar (null → tüm geçmiş). `conn` verilirse çağıranın
     * transaction'ında çalışır; çağıran kullanıcı satırını zaten kilitlemiş olmalıdır (`tz` verirse
     * saat dilimi yeniden okunmaz).
     */
    async recompute(userId, { from = null, conn, now = new Date(), tz } = {}) {
      if (conn) return recomputeIn(conn, userId, { from, now, lock: false, tz });
      return db.withTransaction((c) => recomputeIn(c, userId, { from, now, lock: true }));
    },

    /**
     * Seri bugüne göre hesaplanmadıysa (gün döndü) yeniler. Okuma uçları bunu çağırır; gün dönümü
     * işi kaçsa da seri doğru görünür.
     */
    async fresh(userId, now = new Date()) {
      const tz = await zoneOf(userId);
      const today = localDate(now, tz);
      const stats = await repo.getStats(db, userId);
      const last = stats?.streak_last_date ? isoDate(stats.streak_last_date) : null;
      if (stats && last === today) return stats;
      await service.recompute(userId, { from: today, now });
      return repo.getStats(db, userId);
    },

    /** Bitirme yanıtı için önce/sonra farkı (05 §3, §10). */
    outcome({ before, after }) {
      return {
        streak: {
          current: after.streak,
          best: after.best,
          increased: after.streak > before.streak,
        },
        xpGained: Math.max(0, after.xp - before.xp),
        levelUp: after.level > before.level ? { from: before.level, to: after.level } : null,
      };
    },

    /** GET /v1/user/progress */
    async progress(userId) {
      const s = await service.fresh(userId);
      const lp = levelProgress(s?.xp ?? 0);
      return {
        level: lp.level,
        xp: lp.xp,
        levelXp: lp.levelXp,
        nextLevelXp: lp.nextLevelXp,
        streakDays: s?.current_streak ?? 0,
        bestStreak: s?.best_streak ?? 0,
        completedFasts: s?.completed_fasts ?? 0,
        totalFasts: s?.total_fasts ?? 0,
        totalFastedMinutes: s?.total_fasted_minutes ?? 0,
        longestFastMinutes: s?.longest_fast_minutes ?? 0,
      };
    },

    /**
     * GET /v1/fasts/week — Pzt–Paz hafta şeridi (05 §1.4). Aktif oruç bugüne canlı eklenir;
     * değer DB'ye yazılmaz.
     */
    async week(userId, { date, now = new Date() } = {}) {
      const tz = await zoneOf(userId);
      const today = localDate(now, tz);
      const weekStart = mondayOf(date ?? today);
      const weekEnd = addDays(weekStart, 6);
      const resolveDay = dayResolver(await repo.planHistory(db, userId));
      const fasted = await repo.fastedByDay(db, userId, { from: weekStart, to: weekEnd });
      const checkins = await repo.checkinsByDay(db, userId, { from: weekStart, to: weekEnd });
      const active = await fastingRepo.findActive(db, userId);
      const live = active
        ? Math.max(0, Math.floor((now.getTime() - active.startedAt.getTime()) / 60_000))
        : 0;

      const days = [];
      for (let i = 0; i < 7; i += 1) {
        const d = addDays(weekStart, i);
        const day = resolveDay(d);
        const isToday = d === today;
        const fastedMinutes = (fasted.get(d) ?? 0) + (isToday ? live : 0);
        const checkin = checkins.get(d) ?? null;
        const kept = d > today ? null : dayKept(day, fastedMinutes, checkin);
        days.push({
          date: d,
          dayType: day.type,
          isRequiredDay: day.required,
          goalMinutes: day.goalMinutes,
          fastedMinutes,
          progress: dayProgress(day, fastedMinutes, checkin),
          checkin,
          // Bugün henüz tutulmadıysa sonuç belli değil.
          kept: isToday && kept === false ? null : kept,
          isToday,
          isFuture: d > today,
        });
      }
      return { weekStart, today, days, serverTime: now.toISOString() };
    },

    /** GET /v1/fasts/stats ve /v1/user/stats için aralık hesabı. */
    async rangeStats(userId, range, now = new Date()) {
      const tz = await zoneOf(userId);
      const today = localDate(now, tz);
      const span = RANGE_DAYS[range];
      const from = span ? addDays(today, -(span - 1)) : null;
      const t = await repo.rangeTotals(db, userId, { from, to: today }, MIN_COUNTED_FAST_MINUTES);
      const totals = {
        fasts: t.fasts,
        completedFasts: t.completed,
        completionRate: ratio(t.completed, t.fasts),
        totalFastedMinutes: t.minutes,
        longestFastMinutes: t.longest,
        avgFastMinutes: t.fasts > 0 ? Math.round(t.minutes / t.fasts) : 0,
      };

      let buckets;
      if (span && span <= 31) {
        const resolveDay = dayResolver(await repo.planHistory(db, userId));
        const fasted = await repo.fastedByDay(db, userId, { from, to: today });
        buckets = [];
        for (let d = from; d <= today; d = addDays(d, 1)) {
          buckets.push({
            date: d,
            fastedMinutes: fasted.get(d) ?? 0,
            goalMinutes: resolveDay(d).goalMinutes,
          });
        }
      } else {
        buckets = await repo.monthlyBuckets(db, userId, { from, to: today });
      }
      return {
        range,
        from,
        to: today,
        totals,
        buckets,
        bucketSize: span && span <= 31 ? 'day' : 'month',
      };
    },

    /** GET /v1/user/stats */
    async userStats(userId, range) {
      const s = await service.fresh(userId);
      const r = await service.rangeStats(userId, range);
      return {
        range,
        from: r.from,
        to: r.to,
        ...r.totals,
        currentStreak: s?.current_streak ?? 0,
        bestStreak: s?.best_streak ?? 0,
        weightChangeKg: await repo.weightChange(db, userId, { from: r.from, to: r.to }),
        // Su ve öğün takipçileri F4'te gelir.
        waterGoalDays: 0,
        mealsLogged: 0,
      };
    },

    /** fast-autoclose işi (05 §1.3): 72 saati geçen aktif seansı hedefte bitmiş sayar. */
    async autoClose(userId, fastId, { now = new Date(), maxHours }) {
      return db.withTransaction(async (conn) => {
        await zoneOf(userId, conn, { lock: true });
        const s = await fastingRepo.findById(db, userId, fastId, conn, { forUpdate: true });
        if (!s || s.foreign || s.status !== 'active') return false;
        if (now.getTime() - s.startedAt.getTime() < maxHours * 3_600_000) return false;
        const endLocalDate = localDate(s.plannedEndAt, s.tz);
        await fastingRepo.update(db, conn, s.id, {
          status: 'completed',
          endedAt: s.plannedEndAt,
          durationMinutes: s.targetMinutes,
          goalReached: true,
          endLocalDate,
          autoClosed: true,
        });
        await recomputeIn(conn, userId, { from: endLocalDate, now, lock: false });
        return true;
      });
    },
  };
  return service;
}

function dayProgress(day, fastedMinutes, checkin) {
  if (!day.required) return null;
  if (day.goalMinutes === null) return checkin === 'done' ? 1 : 0;
  return Math.min(1, ratio(fastedMinutes, day.goalMinutes));
}
