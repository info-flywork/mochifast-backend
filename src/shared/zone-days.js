import { isValidTimezone, localDate } from './time.js';

/**
 * Saat dilimine göre günlük işler: her saat dilimi için her YEREL günü bir kez işler.
 *
 * "Yerel saat şu an 0 mı?" kontrolü iki durumda günü kaçırır: (1) gece yarısı DST geçişiyle
 * hiç yaşanmaz (ör. America/Santiago, America/Asuncion, America/Havana); (2) saatlik zamanlayıcı
 * kayar ya da worker o saatte kapalıdır (deploy). Bunun yerine gün dönümünden sonraki ilk çalışma
 * işler; işlenen gün `zone_day_runs`'a yazılır.
 */

/** @returns [{timezone, localDate}] — bu iş için bugünü henüz işlenmemiş dilimler */
export async function pendingZoneDays(db, job, timezones, now = new Date()) {
  const candidates = [...new Set(timezones)]
    .filter(isValidTimezone)
    .map((timezone) => ({ timezone, localDate: localDate(now, timezone) }));
  if (candidates.length === 0) return [];
  const params = { job };
  const pairs = candidates.map((c, i) => {
    params[`t${i}`] = c.timezone;
    params[`d${i}`] = c.localDate;
    return `(:t${i}, :d${i})`;
  });
  const done = await db.many(
    `SELECT timezone, DATE_FORMAT(local_date, '%Y-%m-%d') AS local_date FROM zone_day_runs
      WHERE job = :job AND (timezone, local_date) IN (${pairs.join(', ')})`,
    params,
  );
  const seen = new Set(done.map((r) => `${r.timezone}|${r.local_date}`));
  return candidates.filter((c) => !seen.has(`${c.timezone}|${c.localDate}`));
}

/** İşlenen günleri işaretler (işlem bittikten SONRA: yarıda kalan gün sonraki saatte tekrarlanır). */
export async function markZoneDays(db, job, zoneDays) {
  for (const z of zoneDays) {
    await db.run(
      `INSERT IGNORE INTO zone_day_runs (job, timezone, local_date)
       VALUES (:job, :timezone, :localDate)`,
      { job, timezone: z.timezone, localDate: z.localDate },
    );
  }
}
