import { AppError } from '../../shared/errors.js';
import { toBin } from '../../shared/ids.js';
import { isValidTimezone, localDate } from '../../shared/time.js';

const FUTURE_TOLERANCE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export function fieldError(path, message) {
  return new AppError('VALIDATION_FAILED', { details: { fields: [{ path, message }] } });
}

/** Anlık zaman geçmişte en fazla `pastDays` gün, gelecekte en fazla 5 dk olabilir. */
export function assertInstant(at, now, { path, pastDays }) {
  if (at.getTime() > now.getTime() + FUTURE_TOLERANCE_MS)
    throw fieldError(path, 'must not be in the future');
  if (at.getTime() < now.getTime() - pastDays * DAY_MS) {
    throw fieldError(path, `must be within the last ${pastDays} days`);
  }
}

/** Yerel gün bugünden ileri olamaz, en fazla `pastDays` gün geriye gider. */
export function assertLocalDay(date, today, { path, pastDays }) {
  const diff = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS;
  if (diff < 0) throw fieldError(path, 'must not be in the future');
  if (diff > pastDays) throw fieldError(path, `must be within the last ${pastDays} days`);
}

/**
 * Takipçi yazmaları için ortak çerçeve: kullanıcı satırı kilitli transaction, saat dilimi ve
 * yerel gün. Yazma `touch(date)` ile etkilenen günleri bildirir; transaction kapanmadan o günlerin
 * özeti ve XP'si güncellenir (yanıt döndüğünde ana sayfa günceldir).
 */
export function createTrackerContext({ db, stats }) {
  async function zoneOf(userId, conn, { lock = false } = {}) {
    const row = await db.one(
      `SELECT timezone FROM users WHERE id = :id${lock ? ' FOR UPDATE' : ''}`,
      { id: toBin(userId) },
      conn,
    );
    if (!row) throw new AppError('NOT_FOUND');
    const tz = isValidTimezone(row.timezone) ? row.timezone : 'UTC';
    return { tz, today: localDate(new Date(), tz) };
  }

  return {
    zone: (userId) => zoneOf(userId),

    async write(userId, fn) {
      return db.withTransaction(async (conn) => {
        const zone = await zoneOf(userId, conn, { lock: true });
        const touched = new Set();
        const result = await fn(conn, { ...zone, touch: (date) => touched.add(date) });
        for (const date of [...touched].sort()) await stats.applyDay(userId, date, conn);
        return result;
      });
    },
  };
}
