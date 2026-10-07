import { AppError } from '../../shared/errors.js';
import { fromMinutes, toMinutes, windowMinutes } from '../user/onboarding.rules.js';

/**
 * Plan kuralları (docs/backend/05-is-kurallari.md §2) — saf fonksiyonlar.
 * Plan nesnesi: catalog.service planRules (+ allowedTimings, reducedDaysPerWeek, reducedDayKcal).
 */

/** Zamanlama tercihine göre yeme penceresinin varsayılan başlangıcı (05 §2.1). */
export const TIMING_EAT_START = Object.freeze({
  skip_breakfast: '12:00',
  skip_dinner: '08:00',
  early_window: '07:00',
  late_window: '14:00',
});

export const CUSTOM_FAST_MIN = 12 * 60;
export const CUSTOM_FAST_MAX = 23 * 60;
const CRESCENDO_FAST_MIN = 12 * 60;
const CRESCENDO_FAST_MAX = 16 * 60;
/** Zamanlayıcısı olmayan (haftalık) planlarda başlatılan orucun varsayılan hedefi. */
export const DEFAULT_FAST_MINUTES = 16 * 60;

const fail = (path, message) =>
  new AppError('VALIDATION_FAILED', { details: { fields: [{ path, message }] } });

/**
 * Günlük planlarda (daily, custom_daily) oruç süresi ve yeme penceresi.
 * - Hazır zamanlama: pencere = [varsayılan başlangıç, + plan yeme süresi]
 * - custom: kullanıcının başlangıcı; bitiş verilirse oruç = 1440 − pencere (12–23 sa)
 * - custom_daily planlarda `fastMinutes` 12–23 sa arasında serbest
 */
export function resolveDailyWindow(plan, { timing, eatStart, eatEnd, fastMinutes }) {
  const chosen = timing ?? plan.defaultTiming ?? 'custom';
  if (plan.allowedTimings.length > 0 && !plan.allowedTimings.includes(chosen)) {
    throw fail('timing', `not allowed for plan ${plan.code}`);
  }

  let fast = Math.round((plan.fastHours ?? 16) * 60);
  if (plan.scheduleType === 'custom_daily' && fastMinutes !== undefined) {
    if (fastMinutes < CUSTOM_FAST_MIN || fastMinutes > CUSTOM_FAST_MAX) {
      throw fail('fastMinutes', `must be between ${CUSTOM_FAST_MIN} and ${CUSTOM_FAST_MAX}`);
    }
    fast = fastMinutes;
  }

  let start = TIMING_EAT_START[chosen] ?? eatStart ?? plan.defaultEatStart ?? '12:00';
  if (chosen === 'custom') {
    if (!eatStart) throw fail('eatWindow.start', 'required for custom timing');
    start = eatStart;
    if (eatEnd) {
      const eat = windowMinutes(eatStart, eatEnd);
      const derived = 1440 - eat;
      if (eat === 0 || derived < CUSTOM_FAST_MIN || derived > CUSTOM_FAST_MAX) {
        throw fail('eatWindow', 'fasting time must be between 12 and 23 hours');
      }
      // Hazır planda pencere süresi plana eşit olmalı; özel planda pencere belirleyicidir.
      if (plan.scheduleType === 'custom_daily') fast = derived;
      else if (derived !== fast)
        throw fail('eatWindow', `must be ${1440 - fast} minutes for plan ${plan.code}`);
    }
  }
  return {
    timing: chosen,
    fastMinutes: fast,
    eatWindow: { start, end: fromMinutes(toMinutes(start) + (1440 - fast)) },
  };
}

const DOW = [1, 2, 3, 4, 5, 6, 7];

/**
 * Haftalık programda iki "özel gün" ardışık mı? `wrap`: Pazar → Pazartesi de ardışık sayılır
 * (haftalar arka arkaya geldiği için). Gün aşırı planda 7 gün tek sayı olduğundan wrap yok.
 */
function hasConsecutive(days, { wrap = true } = {}) {
  const set = new Set(days);
  return days.some((d) => (d === 7 ? wrap && set.has(1) : set.has(d + 1)));
}

function normalizeSchedule(schedule) {
  if (!Array.isArray(schedule) || schedule.length !== 7) {
    throw fail('weeklySchedule', 'must contain 7 days');
  }
  const byDow = new Map(schedule.map((d) => [d.dow, d]));
  if (!DOW.every((d) => byDow.has(d))) throw fail('weeklySchedule', 'each dow 1–7 exactly once');
  return DOW.map((d) => byDow.get(d));
}

/**
 * Haftalık/özel program doğrulaması (05 §2.2–2.3). Program verilmezse katalog şablonu kullanılır.
 * @returns doğrulanmış 7 günlük program
 */
export function resolveWeeklySchedule(plan, schedule, template) {
  const days = normalizeSchedule(schedule ?? template);
  const of = (type) => days.filter((d) => d.type === type).map((d) => d.dow);

  switch (plan.scheduleType) {
    case 'weekly_reduced': {
      if (days.some((d) => !['normal', 'reduced'].includes(d.type))) {
        throw fail('weeklySchedule', 'only normal and reduced days');
      }
      const reduced = of('reduced');
      if (reduced.length !== plan.reducedDaysPerWeek) {
        throw fail('weeklySchedule', `exactly ${plan.reducedDaysPerWeek} reduced day(s)`);
      }
      if (hasConsecutive(reduced))
        throw fail('weeklySchedule', 'reduced days must not be consecutive');
      return days.map((d) =>
        d.type === 'reduced'
          ? { dow: d.dow, type: 'reduced', kcal: plan.reducedDayKcal }
          : { dow: d.dow, type: 'normal' },
      );
    }
    case 'alternate_day': {
      const reduced = of('reduced');
      if (days.some((d) => !['normal', 'reduced'].includes(d.type))) {
        throw fail('weeklySchedule', 'only normal and reduced days');
      }
      if (reduced.length < 3 || reduced.length > 4 || hasConsecutive(reduced, { wrap: false })) {
        throw fail('weeklySchedule', 'alternate reduced and normal days');
      }
      return days.map((d) =>
        d.type === 'reduced'
          ? { dow: d.dow, type: 'reduced', kcal: plan.reducedDayKcal }
          : { dow: d.dow, type: 'normal' },
      );
    }
    case 'selected_days': {
      const fasts = days.filter((d) => d.type === 'fast');
      if (days.some((d) => !['normal', 'fast'].includes(d.type))) {
        throw fail('weeklySchedule', 'only normal and fast days');
      }
      if (fasts.length < 2 || fasts.length > 3) throw fail('weeklySchedule', '2 or 3 fast days');
      if (hasConsecutive(fasts.map((d) => d.dow))) {
        throw fail('weeklySchedule', 'fast days must not be consecutive');
      }
      for (const d of fasts) {
        const m = d.fastMinutes ?? Math.round(plan.fastHours * 60);
        if (m < CRESCENDO_FAST_MIN || m > CRESCENDO_FAST_MAX) {
          throw fail('weeklySchedule', 'crescendo fasts must be 12–16 hours');
        }
      }
      return days.map((d) =>
        d.type === 'fast'
          ? {
              dow: d.dow,
              type: 'fast',
              fastMinutes: d.fastMinutes ?? Math.round(plan.fastHours * 60),
            }
          : { dow: d.dow, type: 'normal' },
      );
    }
    case 'custom_weekly':
      return days.map((d) => {
        if (!['fast', 'normal', 'reduced'].includes(d.type))
          throw fail('weeklySchedule', 'invalid day type');
        if (d.type === 'fast') {
          const m = d.fastMinutes ?? DEFAULT_FAST_MINUTES;
          if (m < CUSTOM_FAST_MIN || m > CUSTOM_FAST_MAX) {
            throw fail('weeklySchedule', 'fast days must be 12–23 hours');
          }
          return { dow: d.dow, type: 'fast', fastMinutes: m };
        }
        return d.type === 'reduced'
          ? { dow: d.dow, type: 'reduced', kcal: d.kcal ?? 500 }
          : { dow: d.dow, type: 'normal' };
      });
    default:
      return null;
  }
}

/** Bir günün oruç hedefi (dakika) ve gün tipi. `dow`: 1 = Pazartesi. */
export function dayTarget(userPlan, dow) {
  const entry = userPlan.weeklySchedule?.find((d) => d.dow === dow);
  if (!userPlan.weeklySchedule) return { type: 'fast', fastMinutes: userPlan.fastMinutes };
  if (entry?.type === 'fast') return { type: 'fast', fastMinutes: entry.fastMinutes };
  return { type: entry?.type ?? 'normal', fastMinutes: null };
}

/** Ücretsiz eşdeğer: premium plan seçilemiyorsa önerilecek plan (05 §2.5). */
export const FREE_FALLBACK_PLAN = '16_8';
