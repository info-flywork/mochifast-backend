import { addDays } from '../../shared/time.js';
import { PLANS } from './plans.js';

/**
 * Onboarding/profil iş kuralları — saf fonksiyonlar (docs/backend/05-is-kurallari.md §2.6, §9).
 */

/** Hamilelik/emzirmede izin verilen planlar. */
const PREGNANCY_PLANS = new Set(['12_12', '13_11']);
/** Tıbbi durumlarda bu süreyi aşan planlar güvenlik onayı ister. */
const ACK_FAST_HOURS = 14;
const MEDICAL_FLAGS = ['diabetes', 'medication', 'heart_condition'];

export const REASON_DAYS = Object.freeze({
  special_date: 45,
  trip: 90,
  health_longevity: 180,
  confidence: 120,
});

export const DEFAULT_WEEKLY_LOSS_KG = 0.4;

export function birthYearFromAge(age, todayIso) {
  return Number(todayIso.slice(0, 4)) - age;
}

export function ageFromBirthYear(birthYear, todayIso) {
  return birthYear ? Number(todayIso.slice(0, 4)) - birthYear : null;
}

/** BMI, 1 ondalık. */
export function bmi(weightKg, heightCm) {
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

/** "HH:mm" → gün içi dakika. */
export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(total) {
  const t = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Pencere uzunluğu (dakika); gece yarısını geçen pencere desteklenir. Başlangıç = bitiş → 0. */
export function windowMinutes(start, end) {
  return (toMinutes(end) - toMinutes(start) + 1440) % 1440;
}

/**
 * Sağlık güvenliği (05 §2.6). Sunucuda zorunlu; istemci yalnızca gösterir.
 * @param input.healthFlags DB değerleri (snake_case), `under_18` dahil
 * @returns `{ error: { code, reason } | null, warnings: string[] }`
 */
export function evaluateSafety({
  age,
  healthFlags,
  planCode,
  safetyAcknowledged,
  heightCm,
  goalWeightKg,
}) {
  const warnings = [];
  const flags = new Set(healthFlags);
  const plan = planCode ? PLANS[planCode] : null;
  const fail = (code, reason) => ({ error: { code, reason }, warnings });

  if (plan) {
    if (age !== null && age < plan.minAge) return fail('UNSAFE_REQUEST', 'plan_min_age');
    if ((flags.has('pregnant') || flags.has('breastfeeding')) && !PREGNANCY_PLANS.has(planCode)) {
      return fail('UNSAFE_REQUEST', 'plan_pregnancy');
    }
    if (
      flags.has('eating_disorder_history') &&
      (plan.category === 'advanced' || plan.category === 'weekly')
    ) {
      return fail('UNSAFE_REQUEST', 'plan_eating_disorder');
    }
    const long = plan.scheduleType !== 'daily' || plan.fastHours > ACK_FAST_HOURS;
    if (long && MEDICAL_FLAGS.some((f) => flags.has(f)) && !safetyAcknowledged) {
      return fail('SAFETY_ACK_REQUIRED', 'medical_condition');
    }
  }

  if (heightCm && goalWeightKg) {
    const goalBmi = bmi(goalWeightKg, heightCm);
    if (goalBmi < 17.5) return fail('UNSAFE_REQUEST', 'goal_bmi');
    if (goalBmi < 18.5) warnings.push('GOAL_BMI_BELOW_18_5');
  }
  return { error: null, warnings };
}

/**
 * Plan özeti: günlük planlarda yeme penceresi, kullanıcının öğün penceresinin SONUNDA biter
 * (ör. 07:00–19:00 + 16:8 → 11:00–19:00). Haftalık planlarda süre/pencere yok.
 */
export function planSummary(planCode, mealWindow) {
  const plan = PLANS[planCode];
  if (!plan || plan.scheduleType !== 'daily') {
    return { planCode, fastMinutes: null, eatWindow: null };
  }
  const end = mealWindow?.end ?? '20:00';
  return {
    planCode,
    fastMinutes: plan.fastHours * 60,
    eatWindow: { start: fromMinutes(toMinutes(end) - plan.eatHours * 60), end },
  };
}

/** Öğün penceresi planın yeme süresinden kısaysa uyarı. */
export function mealWindowWarnings(planCode, mealWindow) {
  const plan = PLANS[planCode];
  if (!plan || plan.scheduleType !== 'daily' || !mealWindow) return [];
  return windowMinutes(mealWindow.start, mealWindow.end) < plan.eatHours * 60
    ? ['MEAL_WINDOW_SHORTER_THAN_PLAN']
    : [];
}

/** 05 §9: weeks = ceil(|current − goal| / weeklyLoss); hedef tarih = bugün + clamp(weeks×7, 7, 730). */
export function projection({ currentKg, goalKg, weeklyLossKg = DEFAULT_WEEKLY_LOSS_KG, todayIso }) {
  const weeks = Math.ceil(Math.round(Math.abs(currentKg - goalKg) * 100) / 100 / weeklyLossKg);
  const days = Math.min(Math.max(weeks * 7, 7), 730);
  return {
    currentWeightKg: currentKg,
    goalWeightKg: goalKg,
    weeklyLossKg,
    targetDate: addDays(todayIso, days),
    weeks,
  };
}

export function reasonTargetDate(reason, todayIso) {
  return reason ? addDays(todayIso, REASON_DAYS[reason]) : null;
}
