import { DateTime } from 'luxon';
import { fromBin } from '../shared/ids.js';
import { addDays } from '../shared/time.js';
import { expireChallenges } from '../modules/gamification/challenges.service.js';
import * as repo from '../modules/stats/stats.repository.js';

/** 05 §1.3: bu kadar saat aktif kalan oruç kapatılır. */
export const AUTOCLOSE_AFTER_HOURS = 72;
/** Gece doğrulaması: son bu kadar saatte değişen kullanıcılar (gün sınırı payıyla). */
export const ROLLUP_LOOKBACK_HOURS = 26;
const BATCH = 200;

/**
 * Türetilmiş verilerin işleri (05 §14). Hepsi idempotent: aynı iş iki kez çalışsa da sonuç aynıdır.
 * - fastAutoclose: 72 saati geçen aktif seansı hedefte bitmiş sayar.
 * - dayRollover  : yerel gece yarısını yeni geçen saat dilimlerinde serileri tazeler.
 * - dailyRollup  : son 26 saatte oruç ya da takipçi kaydı değişen kullanıcıların son 3 gününü
 *                  baştan yazar, seri/sayaç/XP'yi tüm geçmişten hesaplar.
 */
export function statsJobs({ db, stats, logger, now = () => new Date() }) {
  async function eachUser(rows, fn) {
    let done = 0;
    for (const row of rows) {
      const userId = Buffer.isBuffer(row.id) ? fromBin(row.id) : row.id;
      try {
        if ((await fn(userId)) !== false) done += 1;
      } catch (err) {
        // Bir kullanıcının hatası partinin kalanını durdurmaz.
        logger.error({ err, userId }, 'kullanıcı işlenemedi');
      }
    }
    return done;
  }

  return {
    async fastAutoclose() {
      let closed = 0;
      for (;;) {
        const rows = await repo.staleActiveFasts(db, AUTOCLOSE_AFTER_HOURS, BATCH);
        const before = closed;
        for (const r of rows) {
          const ok = await stats
            .autoClose(fromBin(r.user_id), fromBin(r.id), {
              now: now(),
              maxHours: AUTOCLOSE_AFTER_HOURS,
            })
            .catch((err) => {
              logger.error({ err, fastId: fromBin(r.id) }, 'oruç otomatik kapatılamadı');
              return false;
            });
          if (ok) closed += 1;
        }
        // Parti dolu ama hiçbiri kapanmadıysa (hep hata) döngüye girme; sonraki çalışma dener.
        if (rows.length < BATCH || closed === before) break;
      }
      if (closed > 0) logger.info({ closed }, '72 saati geçen oruçlar kapatıldı');
    },

    async dayRollover() {
      const at = now();
      const zones = (await repo.streakTimezones(db)).filter(
        (tz) => DateTime.fromJSDate(at, { zone: tz }).hour === 0,
      );
      const users = await repo.usersWithStreakIn(db, zones);
      const refreshed = await eachUser(users, (userId) => stats.fresh(userId, at));
      if (refreshed > 0) logger.info({ refreshed, zones }, 'gün dönümü: seriler tazelendi');
    },

    /** Süresi dolup hedefi tutmayan challenge katılımları (05 §13). */
    async challengeExpire() {
      const failed = await expireChallenges(db);
      if (failed > 0) logger.info({ failed }, 'süresi dolan challenge katılımları kapatıldı');
    },

    async dailyRollup() {
      const at = now();
      // Saat dilimi payıyla son 3 yerel gün; seri yine tüm geçmişten hesaplanır.
      const from = addDays(at.toISOString().slice(0, 10), -2);
      const users = await repo.usersWithRecentChanges(db, ROLLUP_LOOKBACK_HOURS);
      const done = await eachUser(users, (userId) =>
        stats.recompute(userId, { from, now: at, trackers: true }),
      );
      logger.info({ users: done }, 'gece doğrulaması tamamlandı');
    },
  };
}
