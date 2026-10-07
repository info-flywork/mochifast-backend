import { DateTime } from 'luxon';

/**
 * Bildirim kuralları (docs/backend/10-bildirimler.md §4–5). Saf fonksiyonlar.
 */

/** Günlük push sınırları (kullanıcının yerel günü). */
export const DAILY_PUSH_LIMIT = 6;
export const CATEGORY_PUSH_LIMIT = 3;
/** Yeni kullanıcıya ilk günlerde yalnızca oruç push'u (erken kopuşu azaltır). */
export const NEW_USER_DAYS = 3;

/** Kategori → `user_settings` sütunu. `system` her zaman açık (hesap/abonelik bilgisi). */
export const CATEGORY_SETTING = Object.freeze({
  fasting: 'notif_fasting',
  streak: 'notif_streak',
  weight: 'notif_weight',
  water: 'notif_water',
  challenge: 'notif_challenges',
  world: 'notif_world',
  marketing: 'notif_marketing',
  system: null,
});

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * Sessiz saat içinde mi? Gece yarısını aşan aralık desteklenir (22:30–08:00).
 * @returns null (değil) ya da sessiz saatin bittiği an (Date)
 */
export function quietUntil(at, tz, start, end) {
  const local = DateTime.fromJSDate(at, { zone: tz });
  const now = local.hour * 60 + local.minute;
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === e) return null;
  const inside = s < e ? now >= s && now < e : now >= s || now < e;
  if (!inside) return null;
  let endAt = local.set({ hour: Math.floor(e / 60), minute: e % 60, second: 0, millisecond: 0 });
  if (endAt <= local) endAt = endAt.plus({ days: 1 });
  return endAt.toJSDate();
}

/** Şablon yer tutucuları; sayılar dile göre biçimlenir. Bilinmeyen yer tutucu olduğu gibi kalır. */
export function render(text, params, locale) {
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return String(text).replace(/\{(\w+)\}/g, (match, key) => {
    const v = params?.[key];
    if (v === undefined || v === null) return match;
    return typeof v === 'number' ? nf.format(v) : String(v);
  });
}

/**
 * Su hatırlatma saatleri (§4.2): uyanış + 1 sa ile yatış − 1 sa arası, `intervalMin` aralıkla.
 * @returns ["HH:mm", …] yerel saatler
 */
export function waterSlots(wakeTime, bedtime, intervalMin) {
  const first = minutesOf(wakeTime ?? '07:00') + 60;
  let last = minutesOf(bedtime ?? '23:00') - 60;
  if (last <= first) last += 24 * 60;
  const slots = [];
  for (let m = first; m <= last && slots.length < 16; m += Math.max(30, intervalMin)) {
    const v = m % (24 * 60);
    slots.push(`${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`);
  }
  return slots;
}

/** Yerel gün + "HH:mm" → an. Gece yarısını aşan slot ertesi güne düşer. */
export function atLocal(date, hhmm, tz, { after } = {}) {
  const [h, m] = hhmm.split(':').map(Number);
  let dt = DateTime.fromISO(date, { zone: tz }).set({ hour: h, minute: m });
  if (after && dt.toJSDate() < after) dt = dt.plus({ days: 1 });
  return dt.toJSDate();
}

const MIN = 60_000;
/** Evre bildirimi: en derin uygun evre (günde en fazla 1; 10 §2). */
const STAGE_MARKS = [16 * 60, 12 * 60];
/** Yarı yol bildirimi yalnızca uzun oruçlarda (≥ 14 sa). */
const HALFWAY_MIN_TARGET = 14 * 60;
/** Unutulan oruç: planlanan bitişten 12 sa sonra (05 §1.3). */
const OVERDUE_AFTER_MIN = 12 * 60;

/**
 * Aktif oruç için planlanacak bildirimler (10 §4.3). Anahtar öneki `fast:<id>:` — oruç
 * bitince/iptal edilince/düzenlenince önekle iptal edilip yeniden kurulur.
 */
export function fastNotifications({ id, startedAt, targetMinutes, plannedEndAt }) {
  const at = (minutes) => new Date(startedAt.getTime() + minutes * MIN);
  const params = { fastId: id, refType: 'fast', refId: id };
  const out = [
    { type: 'fast_goal_reached', fireAt: plannedEndAt, dedupeKey: `fast:${id}:goal`, params },
  ];
  if (targetMinutes >= HALFWAY_MIN_TARGET) {
    out.push({
      type: 'fast_halfway',
      fireAt: at(targetMinutes / 2),
      dedupeKey: `fast:${id}:half`,
      params,
    });
  }
  const stage = STAGE_MARKS.find((m) => m < targetMinutes);
  if (stage)
    out.push({
      type: 'fast_stage_reached',
      fireAt: at(stage),
      dedupeKey: `fast:${id}:stage`,
      params,
    });
  out.push({
    type: 'fast_overdue',
    fireAt: new Date(plannedEndAt.getTime() + OVERDUE_AFTER_MIN * MIN),
    dedupeKey: `fast:${id}:overdue`,
    params,
  });
  return out;
}

/** Oruç bitince yeme penceresi bildirimleri (anahtar öneki `eat:<id>:`). */
export function eatingWindowNotifications({ id, endedAt, eatMinutes }) {
  if (eatMinutes < 60) return [];
  const at = (minutes) => new Date(endedAt.getTime() + minutes * MIN);
  const params = { fastId: id };
  return [
    {
      type: 'eating_window_ending',
      fireAt: at(eatMinutes - 30),
      dedupeKey: `eat:${id}:ending`,
      params,
    },
    { type: 'meal_window_ended', fireAt: at(eatMinutes), dedupeKey: `eat:${id}:ended`, params },
  ];
}
