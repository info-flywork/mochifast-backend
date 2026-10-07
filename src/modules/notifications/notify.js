import { newId, toBin } from '../../shared/ids.js';

/**
 * Bildirim planlama (docs/backend/10-bildirimler.md §3). Alan servisleri (oruç, seri, dünya,
 * challenge, abonelik…) bunu kendi transaction'larında çağırır; gönderim worker'ın dispatcher'ıdır.
 * Anlık olaylar da buradan geçer (`fireAt` = şimdi): tek kaynak, tek tekrar kontrolü.
 *
 * `dedupeKey` kullanıcı başına tekildir: aynı anahtar tekrar planlanırsa (ör. oruç düzenlendi)
 * henüz gönderilmemişse zamanı/parametreleri güncellenir; gönderildiyse dokunulmaz.
 */
export async function schedule(db, conn, userId, { type, fireAt = new Date(), params, dedupeKey }) {
  await db.run(
    `INSERT INTO scheduled_notifications (id, user_id, type, fire_at, params, dedupe_key)
     VALUES (:id, :userId, :type, :fireAt, :params, :dedupeKey)
     ON DUPLICATE KEY UPDATE
       fire_at = IF(status IN ('sent', 'processing'), fire_at, VALUES(fire_at)),
       params = IF(status IN ('sent', 'processing'), params, VALUES(params)),
       type = IF(status IN ('sent', 'processing'), type, VALUES(type)),
       last_error = IF(status IN ('sent', 'processing'), last_error, NULL),
       status = IF(status IN ('sent', 'processing'), status, 'scheduled')`,
    {
      id: toBin(newId()),
      userId: toBin(userId),
      type,
      fireAt,
      params: params ? JSON.stringify(params) : null,
      dedupeKey: dedupeKey.slice(0, 120),
    },
    conn,
  );
}

/** Önek ile eşleşen, henüz gönderilmemiş bildirimleri iptal eder (ör. `fast:<id>:`). */
export async function cancel(db, conn, userId, dedupePrefix) {
  await db.run(
    `UPDATE scheduled_notifications SET status = 'cancelled'
      WHERE user_id = :userId AND status = 'scheduled' AND dedupe_key LIKE :prefix`,
    { userId: toBin(userId), prefix: `${dedupePrefix.replace(/[\\%_]/g, '\\$&')}%` },
    conn,
  );
}
