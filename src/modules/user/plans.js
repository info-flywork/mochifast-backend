/**
 * Onboarding'de seçilebilen planların asgari tanımı.
 * GEÇİCİ: F2'de `fasting_plans` kataloğu (seed) gelince oradan okunacak; değerler katalogla aynı
 * tutulmalı (docs/backend/03-veri-modeli.md §3.3, 05-is-kurallari.md §2).
 */
export const PLANS = Object.freeze({
  '12_12': plan('beginner', 'daily', 12, 12, 13),
  '13_11': plan('beginner', 'daily', 13, 11, 13),
  '14_10': plan('beginner', 'daily', 14, 10, 13),
  '16_8': plan('popular', 'daily', 16, 8, 18),
  '18_6': plan('intermediate', 'daily', 18, 6, 18),
  '20_4': plan('advanced', 'daily', 20, 4, 18),
  omad: plan('advanced', 'daily', 23, 1, 18),
  '5_2': plan('weekly', 'weekly_reduced', null, null, 18),
});

export const PLAN_CODES = Object.keys(PLANS);

function plan(category, scheduleType, fastHours, eatHours, minAge) {
  return Object.freeze({ category, scheduleType, fastHours, eatHours, minAge });
}
