import { toApiEnum } from '../../shared/enums.js';
import { mealsOfDay } from '../meals/meals.repository.js';
import { levelProgress } from '../stats/stats.rules.js';
import { summariesBetween } from '../trackers/trackers.repository.js';
import { weightProgress as progressOf } from '../trackers/trackers.rules.js';

/**
 * GET /v1/user/summary — ana sayfa, profil başlığı, oruç sekmesi ve widget'lar için tek çağrı
 * (docs/backend/04-api.md §2). Kendi verisi yoktur; modül servislerini birleştirir.
 * Bildirim (F9) alanı ilgili fazda dolar.
 *
 * Uzak DB (~350 ms RTT): tam /me + /goals + /profile yolu (rıza, adım, yiyecek listeleri)
 * kullanılmaz; okumalar mümkün olduğunca tek dalgada paraleldir.
 */
export function createSummaryService({ db, users, plans, fasting, stats, challenges }) {
  return {
    async summary(userId, locale) {
      // 1) Seri tazele + timezone/bugün (tek sefer).
      const { stats: streakRow, tz, today } = await stats.freshContext(userId);
      const progress = formatProgress(streakRow);

      // 2) Kimlik + hafif profil (yiyecek/engel listeleri yok).
      const [header, profilePack] = await Promise.all([
        users.summaryHeader(userId),
        users.summaryProfile(userId, { timezone: tz }),
      ]);
      const { dto: profile, row: profileRow } = profilePack;

      // 3) Kalan okumalar tek dalga (hedefler / plan / oruç / hafta / challenge / bugün).
      const [goals, current, active, week, featured, days, meals] = await Promise.all([
        users.summaryGoals(userId, { profileRow, timezone: tz }),
        plans.current(userId, locale, { profileRow }),
        fasting.active(userId, locale),
        stats.week(userId, { tz, today }),
        challenges.featured(userId, locale),
        summariesBetween(db, userId, { from: today, to: today }),
        mealsOfDay(db, userId, today),
      ]);

      const day = days.get(today);
      const lastMeal = meals.at(-1);
      return {
        user: {
          id: header.id,
          name: header.name,
          avatarUrl: header.avatarUrl,
          isPremium: header.isPremium,
          isGuest: header.isGuest,
          // Birim tercihleri (kg/lb, ml/oz): ana sayfa kartları ve widget'lar için.
          units: header.units,
        },
        progress,
        activeFast: active.fast,
        eatingWindow: active.eatingWindow,
        // `/plans/current` ile aynı DTO: istemci planı (timing dahil) özetten güncelleyebilir.
        plan: current.plan,
        pendingPlanCode: current.pendingPlanCode,
        week: week.days,
        today: {
          date: today,
          water: { ml: day?.water_ml ?? 0, goalMl: goals.waterGoalMl ?? null },
          steps: { count: day?.steps ?? 0, goal: goals.stepsGoal ?? null },
          sleep: { minutes: day?.sleep_minutes ?? 0, goalMin: goals.sleepGoalMin ?? null },
          nutrition: {
            kcal: day?.kcal ?? 0,
            // Yeme bozukluğu geçmişinde hedef gösterilmez (05 §6.3; /nutrition/day ile aynı).
            kcalGoal: profile.healthFlags?.includes('eatingDisorderHistory')
              ? null
              : (goals.kcalGoal ?? goals.computed?.kcalGoal ?? null),
          },
          lastMeal: lastMeal
            ? {
                id: lastMeal.id,
                eatenAt: lastMeal.eatenAt.toISOString(),
                kind: toApiEnum(lastMeal.kind),
                dietType: toApiEnum(lastMeal.dietType),
                feeling: toApiEnum(lastMeal.feeling),
                title: lastMeal.title,
                kcal: lastMeal.kcal,
              }
            : null,
          hunger: { physical: day?.hunger_physical ?? 0, emotional: day?.hunger_emotional ?? 0 },
        },
        weight: weightProgress(profile),
        featuredChallenge: featured.challenge,
        unreadNotifications: 0,
        serverTime: week.serverTime,
      };
    },
  };
}

function formatProgress(s) {
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
