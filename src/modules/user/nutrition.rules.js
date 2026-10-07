import { ageFromBirthYear, bmi } from './onboarding.rules.js';

/**
 * Beslenme hedefleri (docs/backend/05-is-kurallari.md §6) — saf fonksiyonlar.
 * Girdiler DB değerleriyle (snake_case enum'lar) verilir.
 */

const GENDER_OFFSET = { man: 5, woman: -161 };
const OTHER_OFFSET = -78;
const KCAL_FLOOR = { man: 1500, woman: 1200 };
const OTHER_FLOOR = 1350;
const MAX_DEFICIT = 750;
const PROTEIN_PER_KG = 1.2;
const MAX_PROTEIN_G = 160;
const CARB_SHARE = { low_carb: 0.2, mediterranean: 0.5 };
const DEFAULT_CARB_SHARE = 0.6;

/** Mifflin–St Jeor. */
export function bmr({ weightKg, heightCm, age, gender }) {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (GENDER_OFFSET[gender] ?? OTHER_OFFSET);
}

/**
 * Önerilen günlük hedefler. Girdi eksikse ya da yeme bozukluğu geçmişi varsa hepsi null
 * (hedef gösterilmez).
 * @param input.stepKcal adımdan gelen ek harcama (F4'te adım verisiyle dolar)
 */
export function computeNutritionGoals({
  weightKg,
  heightCm,
  age,
  gender,
  goal,
  goalWeightKg,
  diet,
  weeklyLossKg,
  healthFlags = [],
  stepKcal = 0,
}) {
  const empty = { kcalGoal: null, proteinGoalG: null, carbsGoalG: null, fatGoalG: null };
  const flags = new Set(healthFlags);
  if (!weightKg || !heightCm || !age || flags.has('eating_disorder_history')) return empty;

  const tdee = bmr({ weightKg, heightCm, age, gender }) * 1.2 + stepKcal;
  // Açık yalnızca kilo verme hedefinde; hamilelik/emzirme ve 18 yaş altında açık yok.
  const noDeficit =
    flags.has('pregnant') || flags.has('breastfeeding') || flags.has('under_18') || age < 18;
  const deficit =
    goal === 'lose_weight' && !noDeficit ? Math.min((weeklyLossKg * 7700) / 7, MAX_DEFICIT) : 0;
  const floor = KCAL_FLOOR[gender] ?? OTHER_FLOOR;
  const kcal = Math.max(floor, Math.round((tdee - deficit) / 10) * 10);

  const proteinBase = bmi(weightKg, heightCm) >= 30 && goalWeightKg ? goalWeightKg : weightKg;
  const protein = Math.min(Math.round(PROTEIN_PER_KG * proteinBase), MAX_PROTEIN_G);
  const rest = Math.max(0, kcal - protein * 4);
  const carbShare = CARB_SHARE[diet] ?? DEFAULT_CARB_SHARE;
  return {
    kcalGoal: kcal,
    proteinGoalG: protein,
    carbsGoalG: Math.round((rest * carbShare) / 4),
    fatGoalG: Math.round((rest * (1 - carbShare)) / 9),
  };
}

/**
 * Profil satırından hesap girdileri (05 §6.6): yaş doğum yılından, kilo son kayıttan
 * (yoksa başlangıç kilosu).
 */
export function nutritionInputs(profile, todayIso) {
  if (!profile) return {};
  return {
    weightKg: profile.current_weight_kg ?? profile.start_weight_kg,
    heightCm: profile.height_cm,
    age: ageFromBirthYear(profile.birth_year, todayIso),
    gender: profile.gender,
    goal: profile.goal,
    goalWeightKg: profile.goal_weight_kg,
    diet: profile.diet,
    weeklyLossKg: profile.weekly_loss_target_kg,
    healthFlags: (profile.health_flags ?? '').split(',').filter(Boolean),
  };
}

/**
 * Yakılan kalori (05 §6.5): BMR'nin günün geçen kısmı + adım kalorisi. Geçmiş gün tam gün,
 * gelecek gün 0. BMR girdileri eksikse yalnızca adım kalorisi.
 */
export function burnedKcal(inputs, { elapsedMinutes, stepKcal = 0 }) {
  const { weightKg, heightCm, age, gender } = inputs;
  const base = weightKg && heightCm && age ? bmr({ weightKg, heightCm, age, gender }) : 0;
  return Math.round(base * (Math.min(Math.max(elapsedMinutes, 0), 1440) / 1440) + stepKcal);
}
