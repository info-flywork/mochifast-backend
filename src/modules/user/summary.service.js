/**
 * GET /v1/user/summary — ana sayfa, profil başlığı, oruç sekmesi ve widget'lar için tek çağrı
 * (docs/backend/04-api.md §2). Kendi verisi yoktur; modül servislerini birleştirir.
 * Su, adım, öğün, açlık, challenge ve bildirim alanları ilgili fazlarda dolar.
 */
export function createSummaryService({ users, plans, fasting, stats }) {
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
          water: { ml: 0, goalMl: goals.waterGoalMl ?? null },
          steps: { count: 0, goal: goals.stepsGoal ?? null },
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

/** Başlangıçtan hedefe kat edilen yol (0–1). Hedef yoksa ya da başlangıca eşitse null. */
export function weightProgress({ startWeightKg, currentWeightKg, goalWeightKg }) {
  let progress = null;
  if (startWeightKg && currentWeightKg && goalWeightKg && startWeightKg !== goalWeightKg) {
    const raw = (startWeightKg - currentWeightKg) / (startWeightKg - goalWeightKg);
    progress = Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 1000;
  }
  return {
    currentKg: currentWeightKg ?? null,
    startKg: startWeightKg ?? null,
    goalKg: goalWeightKg ?? null,
    progress,
  };
}
