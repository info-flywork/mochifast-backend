import { DateTime, IANAZone } from 'luxon';

/**
 * Tüm anlık zamanlar UTC saklanır; günlük hesaplar kullanıcının IANA saat dilimindeki
 * yerel güne (`local_date`) göre yapılır. (docs/backend/02-mimari.md §3.5)
 */

export function isValidTimezone(tz) {
  return typeof tz === 'string' && tz.length <= 64 && IANAZone.isValidZone(tz);
}

/**
 * Bir anın verilen saat dilimindeki yerel tarihi ("YYYY-MM-DD").
 */
export function localDate(instant, tz) {
  const dt = DateTime.fromMillis(instant instanceof Date ? instant.getTime() : instant, {
    zone: tz,
  });
  if (!dt.isValid) throw new RangeError(`Geçersiz saat dilimi: ${tz}`);
  return dt.toISODate();
}

/**
 * Yerel tarihin içinde bulunduğu haftanın Pazartesi'si (hafta Pazartesi başlar).
 * @param isoDate "YYYY-MM-DD"
 */
export function mondayOf(isoDate) {
  const dt = DateTime.fromISO(isoDate, { zone: 'utc' });
  if (!dt.isValid) throw new RangeError(`Geçersiz tarih: ${isoDate}`);
  return dt.minus({ days: dt.weekday - 1 }).toISODate();
}

/**
 * Yerel bir tarihi gün ekleyerek kaydırır.
 */
export function addDays(isoDate, days) {
  return DateTime.fromISO(isoDate, { zone: 'utc' }).plus({ days }).toISODate();
}

/**
 * DATE sütunu (mysql2 `Date`, UTC gece yarısı) ya da metin → "YYYY-MM-DD".
 */
export function isoDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

/** ISO haftanın günü: 1 = Pazartesi … 7 = Pazar. */
export function isoWeekday(isoDay) {
  return ((new Date(`${isoDay}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** İki yerel tarih arasındaki gün farkı (b − a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
