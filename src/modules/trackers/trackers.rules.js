import { DateTime } from 'luxon';
import { addDays, mondayOf } from '../../shared/time.js';

/**
 * Takipçi kuralları (docs/backend/05-is-kurallari.md §8, §9, §12). Saf fonksiyonlar.
 */

// ── Su (05 §12) ───────────────────────────────────────────────────────
export const WATER_MAX_ENTRY_ML = 5000;
/** Günlük toplam bunu aşınca yanıtta HIGH_WATER_INTAKE uyarısı döner. */
export const WATER_HIGH_DAILY_ML = 6000;

export function waterWarnings(totalMl) {
  return totalMl > WATER_HIGH_DAILY_ML ? ['HIGH_WATER_INTAKE'] : [];
}

// ── Kilo, BMI (05 §9) ─────────────────────────────────────────────────
const BMI_TABLE = [
  [18.5, 'underweight', 'low'],
  [25, 'normal', 'normal'],
  [30, 'overweight', 'high'],
  [35, 'obese1', 'high'],
  [40, 'obese2', 'high'],
  [Infinity, 'obese3', 'high'],
];

export function bmiClass(value) {
  if (value === null || value === undefined) return { bmiCategory: null, bmiBand: null };
  const [, category, band] = BMI_TABLE.find(([limit]) => value < limit);
  return { bmiCategory: category, bmiBand: band };
}

/**
 * Başlangıçtan hedefe kat edilen yol (0–1). Hedef başlangıçtan büyükse (kilo alma) işaretler
 * ters çevrilir; başlangıç hedefe eşitse 1. Eksik değer varsa null.
 */
export function weightProgress(startKg, currentKg, goalKg) {
  if (startKg === null || currentKg === null || goalKg === null) return null;
  if (startKg === undefined || currentKg === undefined || goalKg === undefined) return null;
  if (startKg === goalKg) return 1;
  const raw = (startKg - currentKg) / (startKg - goalKg);
  return Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 1000;
}

// ── Kilo grafiği (05 §9) ──────────────────────────────────────────────
const CHART_BUCKETS = 7;

/**
 * Son 7 kova (en eski önce): day = gün, week = ISO hafta (Pzt), month = ay.
 * @returns [{from, to}] YYYY-MM-DD, `to` dahil
 */
export function chartBuckets(range, today) {
  const buckets = [];
  for (let i = CHART_BUCKETS - 1; i >= 0; i -= 1) {
    if (range === 'day') {
      const d = addDays(today, -i);
      buckets.push({ from: d, to: d });
    } else if (range === 'week') {
      const from = addDays(mondayOf(today), -7 * i);
      buckets.push({ from, to: addDays(from, 6) });
    } else {
      const start = DateTime.fromISO(today, { zone: 'utc' }).startOf('month').minus({ months: i });
      buckets.push({ from: start.toISODate(), to: start.endOf('month').toISODate() });
    }
  }
  return buckets;
}

/** Kova etiketi, istemcinin diline göre (ay kısaltmaları sunucuda yerelleştirilir). */
export function bucketLabel(range, bucket, locale) {
  const dt = DateTime.fromISO(bucket.from, { zone: 'utc' }).setLocale(locale);
  if (range === 'day') return dt.toFormat('ccc');
  if (range === 'week') return dt.toFormat('d MMM');
  return dt.toFormat('LLL');
}

/** Y ekseni: ölçümlerin 2 kg dışına, 5'in katlarına yuvarlanır (sabit 65–120 yerine). */
export function yAxis(values) {
  const list = values.filter((v) => v !== null && v !== undefined);
  if (list.length === 0) return null;
  return {
    min: Math.floor((Math.min(...list) - 2) / 5) * 5,
    max: Math.ceil((Math.max(...list) + 2) / 5) * 5,
  };
}

// ── Adım (05 §8) ──────────────────────────────────────────────────────
const DEFAULT_STRIDE_M = 0.7;
const STEPS_PER_MINUTE = 100;

/** Boy ve kiloya göre kişiselleştirilmiş mesafe, kalori, süre. */
export function stepMetrics(steps, { heightCm, weightKg } = {}) {
  const stride = heightCm ? (heightCm * 0.415) / 100 : DEFAULT_STRIDE_M;
  const weightFactor = weightKg ? weightKg / 70 : 1;
  return {
    distanceKm: Math.round(((steps * stride) / 1000) * 100) / 100,
    kcal: Math.round(steps * 0.04 * weightFactor),
    durationMin: Math.round(steps / STEPS_PER_MINUTE),
  };
}

/** Günün adım kalorisi: sağlık uygulaması ölçtüyse o, yoksa formül. Kayıt yoksa 0. */
export function stepKcal(row, body) {
  if (!row) return 0;
  return row.active_kcal ?? stepMetrics(row.steps, body).kcal;
}

/** Sağlık uygulaması kaynakları manuelden önceliklidir. */
export const STEP_SOURCE_RANK = Object.freeze({ manual: 0, apple_health: 1, google_fit: 1 });

/**
 * Yeni değer mevcut günün üzerine yazılabilir mi? Manuel, senkronlanmış günü ezemez.
 */
export function stepOverwriteAllowed(existingSource, incomingSource) {
  if (!existingSource) return true;
  return STEP_SOURCE_RANK[incomingSource] >= STEP_SOURCE_RANK[existingSource];
}

// ── Uyku ──────────────────────────────────────────────────────────────
/** Tek kayıt en fazla 16 saat; daha uzunu büyük olasılıkla yanlış girilmiş saattir. */
export const SLEEP_MAX_MINUTES = 16 * 60;
