import { AppError } from '../../shared/errors.js';

/**
 * Oruç seansı kuralları (docs/backend/05-is-kurallari.md §1, §4) — saf fonksiyonlar.
 * Zamanlar `Date` (UTC), süreler dakika.
 */

const MIN = 60_000;
export const START_PAST_LIMIT_MS = 7 * 24 * 60 * MIN;
export const MANUAL_PAST_LIMIT_MS = 30 * 24 * 60 * MIN;
export const FUTURE_TOLERANCE_MS = 5 * MIN;
export const CANCEL_DELETE_WINDOW_MS = 10 * MIN;
export const LONG_OVERRUN_MS = 12 * 60 * MIN;
export const MIN_TARGET = 60;
export const MAX_TARGET = 72 * 60;

const invalid = (path, message) =>
  new AppError('VALIDATION_FAILED', { details: { fields: [{ path, message }] } });

/** Başlangıç: [şimdi − 7 gün, şimdi + 5 dk] (geçmiş için /fasts/manual). */
export function assertStartWindow(startedAt, now, { pastLimitMs = START_PAST_LIMIT_MS } = {}) {
  if (startedAt.getTime() < now.getTime() - pastLimitMs) {
    throw invalid('startedAt', 'too far in the past');
  }
  if (startedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw invalid('startedAt', 'cannot be in the future');
  }
}

export function assertTarget(targetMinutes) {
  if (
    !Number.isInteger(targetMinutes) ||
    targetMinutes < MIN_TARGET ||
    targetMinutes > MAX_TARGET
  ) {
    throw invalid('targetMinutes', `must be between ${MIN_TARGET} and ${MAX_TARGET}`);
  }
}

export function plannedEnd(startedAt, targetMinutes) {
  return new Date(startedAt.getTime() + targetMinutes * MIN);
}

/**
 * Bitiş: [başlangıç + 1 dk, şimdi + 5 dk]. Süre ve sonuç (05 §1.2).
 * @returns `{ durationMinutes, goalReached, status, warnings }`
 */
export function finishOutcome({ startedAt, endedAt, targetMinutes, now }) {
  if (endedAt.getTime() < startedAt.getTime() + MIN) {
    throw invalid('endedAt', 'must be at least 1 minute after startedAt');
  }
  if (endedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw invalid('endedAt', 'cannot be in the future');
  }
  const durationMinutes = Math.floor((endedAt.getTime() - startedAt.getTime()) / MIN);
  const goalReached = durationMinutes >= targetMinutes;
  const warnings =
    endedAt.getTime() - plannedEnd(startedAt, targetMinutes).getTime() > LONG_OVERRUN_MS
      ? ['LONG_OVERRUN']
      : [];
  return {
    durationMinutes,
    goalReached,
    status: goalReached ? 'completed' : 'ended_early',
    warnings,
  };
}

/** 10 dk içinde iptal edilen oruç iz bırakmaz (fiziksel silinir). */
export function cancelDeletes(startedAt, now) {
  return now.getTime() - startedAt.getTime() < CANCEL_DELETE_WINDOW_MS;
}

/** İki zaman aralığı çakışıyor mu (uçlar dokunabilir). */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * Vücut evresi (05 §4): başlangıç saati ≤ geçen süre olan son evre.
 * @param stages katalog evreleri ({ position, startHour, … }), sıralı
 */
export function bodyStage(elapsedMinutes, stages, startedAt) {
  const hours = elapsedMinutes / 60;
  let current = stages[0] ?? null;
  for (const s of stages) if (s.startHour !== null && s.startHour <= hours) current = s;
  const next = stages.find((s) => s.startHour !== null && s.startHour > hours) ?? null;
  return current
    ? {
        position: current.position,
        title: current.title,
        rangeLabel: current.rangeLabel,
        imageKey: current.imageKey,
        nextStageAt: next ? new Date(startedAt.getTime() + next.startHour * 60 * MIN) : null,
      }
    : null;
}

/**
 * Yeme penceresi evresi (05 §4): ilk %20 (en az 30 dk) → break, son 60 dk → next,
 * arası → nourish. Pencere dışında null.
 */
export function eatingStage(minutesSinceEnd, eatMinutes) {
  if (minutesSinceEnd < 0 || minutesSinceEnd >= eatMinutes) return null;
  const breakUntil = Math.max(Math.round(eatMinutes * 0.2), 30);
  if (minutesSinceEnd < breakUntil) return 'break';
  if (minutesSinceEnd >= eatMinutes - 60) return 'next';
  return 'nourish';
}

/** Canlı ilerleme (0–1, hedefi geçince 1). */
export function progressOf(elapsedMinutes, targetMinutes) {
  return Math.min(1, Math.round((elapsedMinutes / targetMinutes) * 1000) / 1000);
}
