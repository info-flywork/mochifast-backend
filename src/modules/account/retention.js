/** Saklama süreleri (docs/backend/06-guvenlik.md §8.4, 14 #11). */
/** Misafir hesaplar süreyle silinmez: cihazda kalıcıdır (kullanıcı kararı 2026-10-08). */
export const RETENTION = Object.freeze({
  softDeletedDays: 30,
  readNotificationDays: 90,
  auditMonths: 13,
  closedSessionDays: 30,
  activityDays: 400,
});

const BATCH = 1_000;
const USER_BATCH = 200;

/** Yumuşak silinen kayıtlar (deleted_at) bu süreden sonra kalıcı silinir. */
const SOFT_DELETE_TABLES = Object.freeze([
  'weight_entries',
  'fasting_sessions',
  'water_entries',
  'sleep_entries',
  'meals',
  'hunger_checkins',
  'notifications',
]);

/** Partiler hâlinde siler (uzun kilit tutmaz). @returns silinen satır */
async function deleteInBatches(db, sql, params = {}) {
  let total = 0;
  for (;;) {
    const result = await db.run(`${sql} LIMIT :limit`, { ...params, limit: String(BATCH) });
    total += result.affectedRows;
    if (result.affectedRows < BATCH) return total;
  }
}

/**
 * Günlük saklama işi. Kullanıcı silmeleri doğrudan yapılmaz: silme talebi açılır, silme hattı
 * (deletion.js) yürütür; böylece dosyalar ve dış servisler de temizlenir.
 */
export function createRetention({ db, logger }) {
  return {
    /** Yumuşak silinmiş kayıtlar, okunmuş bildirimler, eski denetim izi ve kapanmış oturumlar. */
    async purgeExpiredRecords() {
      const counts = {};
      for (const table of SOFT_DELETE_TABLES) {
        // Tablo adları sabit listeden gelir.
        counts[table] = await deleteInBatches(
          db,
          `DELETE FROM ${table} WHERE deleted_at < DATE_SUB(NOW(3), INTERVAL :days DAY)`,
          { days: RETENTION.softDeletedDays },
        );
      }
      // Silinmiş sohbetler: önce mesajlar (FK yok), sonra konuşma.
      const conversations = await db.many(
        `SELECT id FROM chat_conversations
          WHERE deleted_at < DATE_SUB(NOW(3), INTERVAL :days DAY) LIMIT :limit`,
        { days: RETENTION.softDeletedDays, limit: String(USER_BATCH) },
      );
      for (const c of conversations) {
        await deleteInBatches(db, 'DELETE FROM chat_messages WHERE conversation_id = :id', {
          id: c.id,
        });
        await db.run('DELETE FROM chat_conversations WHERE id = :id', { id: c.id });
      }
      counts.chat_conversations = conversations.length;
      counts.read_notifications = await deleteInBatches(
        db,
        'DELETE FROM notifications WHERE read_at < DATE_SUB(NOW(3), INTERVAL :days DAY)',
        { days: RETENTION.readNotificationDays },
      );
      counts.media = await deleteInBatches(
        db,
        `DELETE FROM media
          WHERE status IN ('deleted', 'failed')
            AND COALESCE(deleted_at, created_at) < DATE_SUB(NOW(3), INTERVAL :days DAY)`,
        { days: RETENTION.softDeletedDays },
      );
      counts.audit_logs = await deleteInBatches(
        db,
        'DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(3), INTERVAL :months MONTH)',
        { months: RETENTION.auditMonths },
      );
      counts.sessions = await deleteInBatches(
        db,
        `DELETE FROM sessions
          WHERE expires_at < DATE_SUB(NOW(3), INTERVAL :days DAY)
             OR revoked_at < DATE_SUB(NOW(3), INTERVAL :days DAY)`,
        { days: RETENTION.closedSessionDays },
      );
      counts.user_activity_daily = await deleteInBatches(
        db,
        'DELETE FROM user_activity_daily WHERE activity_date < DATE_SUB(UTC_DATE(), INTERVAL :days DAY)',
        { days: RETENTION.activityDays },
      );
      counts.zone_day_runs = await deleteInBatches(
        db,
        'DELETE FROM zone_day_runs WHERE local_date < DATE_SUB(UTC_DATE(), INTERVAL 14 DAY)',
      );
      const total = Object.values(counts).reduce((a, n) => a + n, 0);
      if (total > 0) logger.info(counts, 'saklama süresi dolan kayıtlar silindi');
      return counts;
    },
  };
}
