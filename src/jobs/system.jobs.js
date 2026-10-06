/** Biten işler bu kadar gün tutulur (hata ayıklama için), sonra silinir. */
export const JOB_RETENTION_DAYS = Object.freeze({ done: 7, failed: 30 });

const CLEANUP_BATCH = 1_000;

/**
 * `system` kuyruğunun işleri.
 * - heartbeat  : zamanlayıcı → kuyruk → worker hattının uçtan uca çalıştığını kanıtlar.
 * - jobsCleanup: eski biten/başarısız iş satırlarını küçük partilerle siler (uzun kilit tutmaz).
 */
export function systemJobs({ db, logger }) {
  return {
    async heartbeat(job) {
      logger.debug({ jobId: job.id }, 'heartbeat');
    },

    async jobsCleanup() {
      let deleted = 0;
      for (const [status, days] of Object.entries(JOB_RETENTION_DAYS)) {
        for (;;) {
          const result = await db.run(
            `DELETE FROM jobs
              WHERE status = :status AND finished_at < DATE_SUB(NOW(3), INTERVAL :days DAY)
              LIMIT :limit`,
            // mysql2 prepared statement'ta LIMIT parametresi string olmalı.
            { status, days, limit: String(CLEANUP_BATCH) },
          );
          deleted += result.affectedRows;
          if (result.affectedRows < CLEANUP_BATCH) break;
        }
      }
      if (deleted > 0) logger.info({ deleted }, 'eski iş kayıtları silindi');
    },
  };
}
