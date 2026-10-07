import { describe, expect, it } from 'vitest';
import {
  bmiClass,
  bucketLabel,
  chartBuckets,
  stepMetrics,
  stepOverwriteAllowed,
  waterWarnings,
  weightProgress,
  yAxis,
} from '../../src/modules/trackers/trackers.rules.js';

describe('BMI sınıfı (05 §9)', () => {
  it('kategori ve bant sınırları', () => {
    const cases = [
      [18.4, 'underweight', 'low'],
      [18.5, 'normal', 'normal'],
      [24.9, 'normal', 'normal'],
      [25, 'overweight', 'high'],
      [30, 'obese1', 'high'],
      [35, 'obese2', 'high'],
      [40, 'obese3', 'high'],
    ];
    for (const [value, category, band] of cases) {
      expect(bmiClass(value)).toEqual({ bmiCategory: category, bmiBand: band });
    }
    expect(bmiClass(null)).toEqual({ bmiCategory: null, bmiBand: null });
  });
});

describe('kilo ilerlemesi', () => {
  it('verme hedefi, alma hedefi (ters), eşit başlangıç/hedef', () => {
    expect(weightProgress(112.2, 102.5, 75.2)).toBeCloseTo(0.262, 3);
    expect(weightProgress(50, 53, 56)).toBe(0.5); // kilo alma
    expect(weightProgress(70, 75, 60)).toBe(0); // geri gitti → 0'da kalır
    expect(weightProgress(80, 80, 80)).toBe(1);
    expect(weightProgress(80, 80, null)).toBeNull();
  });
});

describe('kilo grafiği', () => {
  const today = '2026-10-07'; // Çarşamba

  it('day: son 7 gün; week: son 7 ISO hafta; month: son 7 ay', () => {
    const day = chartBuckets('day', today);
    expect(day).toHaveLength(7);
    expect(day[0]).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(day[6]).toEqual({ from: today, to: today });

    const week = chartBuckets('week', today);
    expect(week[6]).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(week[0]).toEqual({ from: '2026-08-24', to: '2026-08-30' });

    const month = chartBuckets('month', today);
    expect(month[6]).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(month[0]).toEqual({ from: '2026-04-01', to: '2026-04-30' });
    expect(month[4]).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('etiketler dile göre yerelleştirilir', () => {
    const b = { from: '2026-10-07', to: '2026-10-07' };
    expect(bucketLabel('day', b, 'tr')).toBe('Çar');
    expect(bucketLabel('day', b, 'en')).toBe('Wed');
    expect(bucketLabel('month', { from: '2026-10-01' }, 'tr')).toBe('Eki');
    expect(bucketLabel('month', { from: '2026-10-01' }, 'en')).toBe('Oct');
  });

  it('kabul kriteri: Y ekseni 50 kg ve 140 kg kullanıcılar için doğru', () => {
    expect(yAxis([50.2, 49.1, null, 48.7])).toEqual({ min: 45, max: 55 });
    expect(yAxis([140, 138.4, 141.2])).toEqual({ min: 135, max: 145 });
    expect(yAxis([null, null])).toBeNull();
  });
});

describe('adım (05 §8)', () => {
  it('boy ve kiloya göre kişisel; yoksa varsayılan', () => {
    expect(stepMetrics(10_000, { heightCm: 180, weightKg: 70 })).toEqual({
      distanceKm: 7.47,
      kcal: 400,
      durationMin: 100,
    });
    expect(stepMetrics(10_000)).toEqual({ distanceKm: 7, kcal: 400, durationMin: 100 });
    expect(stepMetrics(10_000, { weightKg: 105 }).kcal).toBe(600);
  });

  it('kaynak önceliği: sağlık manueli ezer, manuel senkronu ezemez', () => {
    expect(stepOverwriteAllowed(undefined, 'manual')).toBe(true);
    expect(stepOverwriteAllowed('manual', 'apple_health')).toBe(true);
    expect(stepOverwriteAllowed('google_fit', 'manual')).toBe(false);
    expect(stepOverwriteAllowed('apple_health', 'apple_health')).toBe(true);
  });
});

describe('su', () => {
  it('günlük 6000 ml üstü uyarı', () => {
    expect(waterWarnings(6000)).toEqual([]);
    expect(waterWarnings(6001)).toEqual(['HIGH_WATER_INTAKE']);
  });
});
