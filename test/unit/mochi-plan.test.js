import { describe, expect, it } from 'vitest';
import {
  clampAiHours,
  median,
  parseAiPlan,
  recommendFast,
  roundToHalfHour,
} from '../../src/modules/fasting/mochi-plan.js';

describe('Mochi günlük plan', () => {
  it('kayıtlı plandan bağımsız: kilo hedefinde 16, alışkanlıkta 14, varsayılan başlangıç 20:00', () => {
    expect(recommendFast({ goal: 'lose_weight' })).toMatchObject({
      fastHours: 16,
      eatHours: 8,
      startMinutes: 20 * 60,
      reason: 'weight_goal',
    });
    expect(recommendFast({ goal: 'build_habit' })).toMatchObject({
      fastHours: 14,
      eatHours: 10,
      reason: 'steady',
    });
  });

  it('kısa uyku, zorlanma ve yarım kalan oruç süreyi kısaltır', () => {
    expect(recommendFast({ goal: 'lose_weight', sleepMinutes: 5 * 60 }).reason).toBe('short_sleep');
    expect(recommendFast({ goal: 'lose_weight', sleepMinutes: 4 * 60 }).fastHours).toBe(12);
    expect(
      recommendFast({ goal: 'lose_weight', struggles: 3, fastsEnded: 4, fastsReached: 4 }),
    ).toMatchObject({ fastHours: 14, reason: 'struggles' });
    expect(recommendFast({ goal: 'lose_weight', fastsEnded: 4, fastsReached: 1 })).toMatchObject({
      fastHours: 14,
      reason: 'low_completion',
    });
  });

  it('yoğun adım günü ve istikrarlı seri süreyi oynatır', () => {
    expect(
      recommendFast({ goal: 'build_habit', stepsYesterday: 15000, stepsGoal: 8000 }),
    ).toMatchObject({ fastHours: 12, reason: 'hard_day' });
    expect(
      recommendFast({
        goal: 'lose_weight',
        fastsEnded: 5,
        fastsReached: 5,
        sleepMinutes: 8 * 60,
        struggles: 0,
      }),
    ).toMatchObject({ fastHours: 18, reason: 'ready_longer' });
  });

  it('hamilelik ve 18 yaş altı 12 saatte kalır; AI bunu uzatamaz', () => {
    const gentle = recommendFast({
      goal: 'lose_weight',
      healthFlags: ['pregnant'],
      sleepMinutes: 480,
    });
    expect(gentle).toMatchObject({ fastHours: 12, eatHours: 12, reason: 'safety', maxHours: 12 });
    expect(clampAiHours(gentle.fastHours, 18, gentle.minHours, gentle.maxHours)).toBe(12);
    expect(recommendFast({ age: 16, goal: 'lose_weight' }).fastHours).toBe(12);
  });

  it('diyabet 14 saati aşmaz', () => {
    expect(recommendFast({ goal: 'lose_weight', healthFlags: ['diabetes'] })).toMatchObject({
      fastHours: 14,
      reason: 'safety',
      maxHours: 14,
    });
  });

  it('alışılmış başlangıç yarım saate yuvarlanır', () => {
    expect(median([19 * 60 + 10, 20 * 60 + 40, 21 * 60])).toBe(20 * 60 + 40);
    expect(roundToHalfHour(20 * 60 + 10)).toBe(20 * 60);
    expect(roundToHalfHour(20 * 60 + 20)).toBe(20 * 60 + 30);
    expect(recommendFast({ typicalStartMinutes: 19 * 60 + 50 }).startMinutes).toBe(20 * 60);
  });

  it('AI metninden yalnızca JSON okunur ve süre ±2 saat içinde kalır', () => {
    expect(parseAiPlan('not json')).toBeNull();
    expect(parseAiPlan('```json\n{"fastHours":15,"insight":"Bugün 15 saat yeter."}\n```')).toEqual({
      fastHours: 15,
      insight: 'Bugün 15 saat yeter.',
    });
    expect(clampAiHours(16, 20, 12, 18)).toBe(18);
    expect(clampAiHours(16, 12, 12, 18)).toBe(14);
    expect(clampAiHours(16, null, 12, 18)).toBe(16);
  });
});
