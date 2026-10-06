import { describe, expect, it } from 'vitest';
import { apiToSet, setToApi, toApiEnum, toDbEnum } from '../../src/shared/enums.js';
import { computeNutritionGoals } from '../../src/modules/user/nutrition.rules.js';
import {
  bmi,
  evaluateSafety,
  mealWindowWarnings,
  planSummary,
  projection,
  reasonTargetDate,
  windowMinutes,
} from '../../src/modules/user/onboarding.rules.js';

describe('enum dönüşümü', () => {
  it('snake_case ↔ lowerCamelCase', () => {
    for (const [db, api] of [
      ['lose_weight', 'loseWeight'],
      ['prefer_not_to_say', 'preferNotToSay'],
      ['ft_in', 'ftIn'],
      ['eating_disorder_history', 'eatingDisorderHistory'],
      ['woman', 'woman'],
    ]) {
      expect(toApiEnum(db)).toBe(api);
      expect(toDbEnum(api)).toBe(db);
    }
    expect(toApiEnum(null)).toBeNull();
  });

  it('SET kolonu', () => {
    expect(setToApi('pregnant,eating_disorder_history')).toEqual([
      'pregnant',
      'eatingDisorderHistory',
    ]);
    expect(setToApi('')).toEqual([]);
    expect(apiToSet(['heartCondition', 'diabetes', 'diabetes'])).toBe('heart_condition,diabetes');
  });
});

/** Katalogdaki plan kuralları (seeds/plans.json ile aynı değerler). */
const PLANS = {
  '12_12': {
    code: '12_12',
    category: 'beginner',
    scheduleType: 'daily',
    fastHours: 12,
    eatHours: 12,
    minAge: 13,
  },
  '13_11': {
    code: '13_11',
    category: 'beginner',
    scheduleType: 'daily',
    fastHours: 13,
    eatHours: 11,
    minAge: 13,
  },
  '14_10': {
    code: '14_10',
    category: 'beginner',
    scheduleType: 'daily',
    fastHours: 14,
    eatHours: 10,
    minAge: 13,
  },
  '16_8': {
    code: '16_8',
    category: 'popular',
    scheduleType: 'daily',
    fastHours: 16,
    eatHours: 8,
    minAge: 18,
  },
  '18_6': {
    code: '18_6',
    category: 'intermediate',
    scheduleType: 'daily',
    fastHours: 18,
    eatHours: 6,
    minAge: 18,
  },
  omad: {
    code: 'omad',
    category: 'advanced',
    scheduleType: 'daily',
    fastHours: 23,
    eatHours: 1,
    minAge: 18,
  },
  '5_2': {
    code: '5_2',
    category: 'weekly',
    scheduleType: 'weekly_reduced',
    fastHours: null,
    eatHours: null,
    minAge: 18,
  },
  early_tre: {
    code: 'early_tre',
    category: 'flexible',
    scheduleType: 'custom_daily',
    fastHours: 16,
    eatHours: 8,
    minAge: 18,
  },
};

describe('sağlık güvenliği (05 §2.6)', () => {
  const base = { age: 30, healthFlags: [], heightCm: 170, goalWeightKg: 60 };

  it('18 yaş altı: yalnızca min_age ≤ yaş planlar', () => {
    expect(evaluateSafety({ ...base, age: 16, plan: PLANS['omad'] }).error).toEqual({
      code: 'UNSAFE_REQUEST',
      reason: 'plan_min_age',
    });
    expect(evaluateSafety({ ...base, age: 16, plan: PLANS['14_10'] }).error).toBeNull();
  });

  it('hamilelik/emzirme: yalnızca 12:12 ve 13:11', () => {
    const flags = ['breastfeeding'];
    expect(evaluateSafety({ ...base, healthFlags: flags, plan: PLANS['16_8'] }).error?.reason).toBe(
      'plan_pregnancy',
    );
    expect(evaluateSafety({ ...base, healthFlags: flags, plan: PLANS['13_11'] }).error).toBeNull();
  });

  it('yeme bozukluğu geçmişi: advanced/weekly kapalı', () => {
    const flags = ['eating_disorder_history'];
    expect(evaluateSafety({ ...base, healthFlags: flags, plan: PLANS['5_2'] }).error?.code).toBe(
      'UNSAFE_REQUEST',
    );
    expect(evaluateSafety({ ...base, healthFlags: flags, plan: PLANS['18_6'] }).error).toBeNull();
  });

  it('diyabet/ilaç/kalp: >14 sa planda güvenlik onayı', () => {
    const flags = ['diabetes'];
    expect(evaluateSafety({ ...base, healthFlags: flags, plan: PLANS['16_8'] }).error?.code).toBe(
      'SAFETY_ACK_REQUIRED',
    );
    expect(
      evaluateSafety({ ...base, healthFlags: flags, plan: PLANS['16_8'], safetyAcknowledged: true })
        .error,
    ).toBeNull();
    expect(evaluateSafety({ ...base, healthFlags: flags, plan: PLANS['14_10'] }).error).toBeNull();
  });

  it('hedef BMI: < 18.5 uyarı, < 17.5 red', () => {
    expect(evaluateSafety({ ...base, goalWeightKg: 52, plan: PLANS['16_8'] }).warnings).toEqual([
      'GOAL_BMI_BELOW_18_5',
    ]);
    expect(evaluateSafety({ ...base, goalWeightKg: 50, plan: PLANS['16_8'] }).error?.reason).toBe(
      'goal_bmi',
    );
    expect(bmi(74, 172)).toBe(25);
  });
});

describe('plan özeti ve projeksiyon', () => {
  it('yeme penceresi öğün penceresinin sonunda biter; gece yarısını geçebilir', () => {
    expect(planSummary(PLANS['16_8'], { start: '07:00', end: '19:00' })).toEqual({
      planCode: '16_8',
      fastMinutes: 960,
      eatWindow: { start: '11:00', end: '19:00' },
    });
    expect(planSummary(PLANS['16_8'], { start: '15:00', end: '01:00' }).eatWindow).toEqual({
      start: '17:00',
      end: '01:00',
    });
    expect(planSummary(PLANS.early_tre, { start: '07:00', end: '15:00' }).eatWindow).toEqual({
      start: '07:00',
      end: '15:00',
    });
    expect(planSummary(PLANS['5_2'], { start: '07:00', end: '19:00' })).toEqual({
      planCode: '5_2',
      fastMinutes: null,
      eatWindow: null,
    });
  });

  it('pencere süresi ve plan uyarısı', () => {
    expect(windowMinutes('22:00', '02:00')).toBe(240);
    expect(mealWindowWarnings(PLANS['16_8'], { start: '12:00', end: '18:00' })).toEqual([
      'MEAL_WINDOW_SHORTER_THAN_PLAN',
    ]);
    expect(mealWindowWarnings(PLANS['16_8'], { start: '07:00', end: '19:00' })).toEqual([]);
  });

  it('projeksiyon: 74 → 64 kg, haftada 0.4 → 25 hafta', () => {
    expect(projection({ currentKg: 74, goalKg: 64, todayIso: '2026-10-06' })).toEqual({
      currentWeightKg: 74,
      goalWeightKg: 64,
      weeklyLossKg: 0.4,
      targetDate: '2027-03-30',
      weeks: 25,
    });
    // Hedef = mevcut → en az 7 gün; 730 günü aşamaz.
    expect(projection({ currentKg: 70, goalKg: 70, todayIso: '2026-10-06' }).targetDate).toBe(
      '2026-10-13',
    );
    expect(projection({ currentKg: 200, goalKg: 60, todayIso: '2026-10-06' }).targetDate).toBe(
      '2028-10-05',
    );
  });

  it('sebebe göre hedef tarih', () => {
    expect(reasonTargetDate('special_date', '2026-10-06')).toBe('2026-11-20');
    expect(reasonTargetDate('trip', '2026-10-06')).toBe('2027-01-04');
  });
});

describe('beslenme hedefleri (05 §6)', () => {
  const woman = {
    weightKg: 74,
    heightCm: 172,
    age: 29,
    gender: 'woman',
    goal: 'lose_weight',
    goalWeightKg: 64,
    diet: 'everything',
    weeklyLossKg: 0.4,
  };

  it('kilo verme: TDEE − açık, makrolar diyete göre', () => {
    expect(computeNutritionGoals(woman)).toEqual({
      kcalGoal: 1370,
      proteinGoalG: 89,
      carbsGoalG: 152,
      fatGoalG: 45,
    });
    expect(computeNutritionGoals({ ...woman, diet: 'low_carb' }).carbsGoalG).toBe(51);
  });

  it('hamilelikte ve 18 yaş altında açık yok; tabanın altına inmez', () => {
    expect(computeNutritionGoals({ ...woman, healthFlags: ['pregnant'] }).kcalGoal).toBe(1810);
    expect(computeNutritionGoals({ ...woman, age: 16 }).kcalGoal).toBeGreaterThan(1800);
    expect(computeNutritionGoals({ ...woman, weightKg: 45, heightCm: 150, age: 60 }).kcalGoal).toBe(
      1200,
    );
  });

  it('yeme bozukluğu geçmişi ya da eksik girdi → hedef yok', () => {
    const none = { kcalGoal: null, proteinGoalG: null, carbsGoalG: null, fatGoalG: null };
    expect(computeNutritionGoals({ ...woman, healthFlags: ['eating_disorder_history'] })).toEqual(
      none,
    );
    expect(computeNutritionGoals({ ...woman, heightCm: null })).toEqual(none);
  });

  it('BMI ≥ 30: protein hedef kiloya göre, en fazla 160 g', () => {
    const heavy = { ...woman, weightKg: 120, goalWeightKg: 80, gender: 'man', heightCm: 180 };
    expect(computeNutritionGoals(heavy).proteinGoalG).toBe(96);
    expect(
      computeNutritionGoals({ ...heavy, weightKg: 140, goalWeightKg: 140, heightCm: 250 })
        .proteinGoalG,
    ).toBe(160);
  });
});
