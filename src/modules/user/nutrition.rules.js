import { bmi } from './onboarding.rules.js';

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
