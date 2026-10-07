import { describe, expect, it } from 'vitest';
import { scoreHunger } from '../../src/modules/hunger/hunger.rules.js';
import { burnedKcal, computeNutritionGoals } from '../../src/modules/user/nutrition.rules.js';

const physical = {
  q1: 'yes',
  q2: 'gradually',
  bodyNotices: ['stomachGrowling', 'lowEnergy', 'fatigue'],
  q4: 'almostAnything',
};
const emotional = {
  q1: 'notReally',
  q2: 'suddenly',
  bodyNotices: ['nothingPhysical'],
  q4: 'somethingSweet',
};

describe('açlık skorlaması (05 §5)', () => {
  it('fiziksel: Q3 üçlüsü en fazla +2', () => {
    expect(scoreHunger(physical)).toMatchObject({
      resultType: 'physical',
      physicalScore: 8,
      emotionalScore: 0,
      safetyFlag: false,
      recommendationCodes: ['physical_1', 'physical_2', 'physical_3'],
    });
  });

  it('duygusal; fast food +1', () => {
    expect(scoreHunger(emotional)).toMatchObject({ resultType: 'emotional', emotionalScore: 8 });
    expect(scoreHunger({ q4: 'fastFood' })).toMatchObject({ physicalScore: 0, emotionalScore: 1 });
    expect(scoreHunger(emotional).recommendationCodes).toHaveLength(4);
  });

  it('eşitlikte fiziksel; notSure puansız', () => {
    expect(scoreHunger({ q1: 'yes', q2: 'suddenly' }).resultType).toBe('physical');
    expect(scoreHunger({ q1: 'notSure', q2: 'notSure', q4: 'notSure' })).toMatchObject({
      physicalScore: 0,
      emotionalScore: 0,
      resultType: 'physical',
    });
  });

  it('kabul kriteri: aynı cevaplar her zaman aynı sonucu verir', () => {
    const runs = Array.from({ length: 50 }, () => scoreHunger(emotional, null));
    expect(new Set(runs.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("bağlam: planın %75'ini geçen oruçta fiziksel belirti varsa +1", () => {
    const answers = { bodyNotices: ['stomachGrowling'] };
    expect(scoreHunger(answers, { fastedMinutes: 720, targetMinutes: 960 }).physicalScore).toBe(2);
    expect(scoreHunger(answers, { fastedMinutes: 719, targetMinutes: 960 }).physicalScore).toBe(1);
    expect(scoreHunger({}, { fastedMinutes: 900, targetMinutes: 960 }).physicalScore).toBe(0);
  });

  it('güvenlik bayrağı ve öncelikli öneri', () => {
    const fast = (h) => ({ fastedMinutes: h * 60, targetMinutes: 1080 });
    expect(scoreHunger({ bodyNotices: ['dizziness', 'nausea'] }).safetyFlag).toBe(true);
    expect(scoreHunger({ bodyNotices: ['dizziness'] }, fast(17)).safetyFlag).toBe(true);
    expect(scoreHunger({ symptoms: ['nausea'] }, fast(17)).safetyFlag).toBe(true);
    expect(scoreHunger({ bodyNotices: ['dizziness'] }, fast(15)).safetyFlag).toBe(false);
    expect(scoreHunger({ symptoms: ['dizziness', 'weakness'] }).safetyFlag).toBe(true);
    expect(scoreHunger({ symptoms: ['headache'] }).safetyFlag).toBe(false);
    expect(scoreHunger({ bodyNotices: ['dizziness', 'nausea'] }).recommendationCodes[0]).toBe(
      'safety_end_fast',
    );
  });
});

describe('beslenme (05 §6)', () => {
  const inputs = { weightKg: 70, heightCm: 170, age: 30, gender: 'woman' };

  it('kabul kriteri: yeme bozukluğu geçmişinde kalori hedefi null', () => {
    expect(
      computeNutritionGoals({ ...inputs, healthFlags: ['eating_disorder_history'] }).kcalGoal,
    ).toBeNull();
  });

  it("adım kalorisi TDEE'ye eklenir", () => {
    const base = computeNutritionGoals({ ...inputs, goal: 'build_habit' }).kcalGoal;
    const withSteps = computeNutritionGoals({
      ...inputs,
      goal: 'build_habit',
      stepKcal: 300,
    }).kcalGoal;
    expect(withSteps - base).toBe(300);
  });

  it('yakılan kalori: BMR × geçen gün oranı + adım', () => {
    // BMR = 700 + 1062.5 − 150 − 161 = 1451.5
    expect(burnedKcal(inputs, { elapsedMinutes: 720, stepKcal: 100 })).toBe(826);
    expect(burnedKcal(inputs, { elapsedMinutes: 1440 })).toBe(1452);
    expect(burnedKcal({}, { elapsedMinutes: 720, stepKcal: 50 })).toBe(50);
  });
});
