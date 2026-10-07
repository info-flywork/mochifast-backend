import { summariesBetween } from '../trackers/trackers.repository.js';
import { weightProgress as progressOf } from '../trackers/trackers.rules.js';

/**
 * GET /v1/user/summary — ana sayfa, profil başlığı, oruç sekmesi ve widget'lar için tek çağrı
 * (docs/backend/04-api.md §2). Kendi verisi yoktur; modül servislerini birleştirir.
 * Öğün, açlık, challenge ve bildirim alanları ilgili fazlarda dolar.
 */
export function createSummaryService({ db, users, plans, fasting, stats }) {
  return {
    async summary(userId, locale) {
      // Önce: seri bugüne göre tazelenir (gün döndüyse yazar); diğerleri yalnızca okur.
      const progress = await stats.progress(userId);
      const [me, profile, goals, current, active, week] = await Promise.all([
        users.getMe(userId),
        users.getProfile(userId),
        users.getGoals(userId),
        plans.current(userId, locale),
        fasting.active(userId, locale),
        stats.week(userId),
      ]);
      const day = (await summariesBetween(db, userId, { from: week.today, to: week.today })).get(
        week.today,
      );
      return {
        user: {
          id: me.id,
          name: me.name,
          avatarUrl: me.avatarUrl,
          isPremium: me.isPremium,
          isGuest: me.isGuest,
        },
        progress,
        activeFast: active.fast,
        eatingWindow: active.eatingWindow,
        plan: current.plan && {
          planCode: current.plan.planCode,
          displayName: current.plan.displayName,
          fastMinutes: current.plan.fastMinutes,
          eatWindow: current.plan.eatWindow,
        },
        pendingPlanCode: current.pendingPlanCode,
        week: week.days,
        today: {
          date: week.today,
          water: { ml: day?.water_ml ?? 0, goalMl: goals.waterGoalMl ?? null },
          steps: { count: day?.steps ?? 0, goal: goals.stepsGoal ?? null },
          sleep: { minutes: day?.sleep_minutes ?? 0, goalMin: goals.sleepGoalMin ?? null },
          nutrition: { kcal: 0, kcalGoal: goals.kcalGoal ?? goals.computed?.kcalGoal ?? null },
          lastMeal: null,
          hunger: { physical: 0, emotional: 0 },
        },
        weight: weightProgress(profile),
        featuredChallenge: null,
        unreadNotifications: 0,
        serverTime: week.serverTime,
      };
    },
  };
}

/** Kilo kartı: başlangıç, güncel, hedef ve kat edilen yol (05 §9). */
export function weightProgress({ startWeightKg, currentWeightKg, goalWeightKg }) {
  const start = startWeightKg ?? null;
  const current = currentWeightKg ?? start;
  const goal = goalWeightKg ?? null;
  return {
    currentKg: current,
    startKg: start,
    goalKg: goal,
    progress: progressOf(start, current, goal),
  };
}
