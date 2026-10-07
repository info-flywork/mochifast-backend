import { fromBin, newId, toBin } from '../../shared/ids.js';

/**
 * Hesap silme ve veri dışa aktarma talepleri (docs/backend/06-guvenlik.md §8).
 * Transaction içinde çağrılanlar `conn` alır.
 */

// ── Silme talepleri ───────────────────────────────────────────────────
const toDeletion = (r) =>
  r && {
    id: fromBin(r.id),
    userId: fromBin(r.user_id),
    source: r.source,
    status: r.status,
    requestedAt: r.requested_at,
    scheduledFor: r.scheduled_for,
  };

const DELETION_COLUMNS = 'id, user_id, source, status, requested_at, scheduled_for';

export async function insertDeletionRequest(db, conn, { userId, source, scheduledFor, reason }) {
  const id = newId();
  await db.run(
    `INSERT INTO account_deletion_requests (id, user_id, source, scheduled_for, reason)
     VALUES (:id, :userId, :source, :scheduledFor, :reason)`,
    { id: toBin(id), userId: toBin(userId), source, scheduledFor, reason: reason ?? null },
    conn,
  );
  return id;
}

/** Kullanıcının bekleyen (scheduled) talebi. */
export async function scheduledDeletion(db, userId, conn) {
  return toDeletion(
    await db.one(
      `SELECT ${DELETION_COLUMNS} FROM account_deletion_requests
        WHERE user_id = :userId AND status = 'scheduled'
        ORDER BY requested_at DESC LIMIT 1`,
      { userId: toBin(userId) },
      conn,
    ),
  );
}

export async function cancelDeletion(db, conn, userId) {
  await db.run(
    `UPDATE account_deletion_requests SET status = 'cancelled'
      WHERE user_id = :userId AND status = 'scheduled'`,
    { userId: toBin(userId) },
    conn,
  );
}

export async function findDeletion(db, id) {
  return toDeletion(
    await db.one(`SELECT ${DELETION_COLUMNS} FROM account_deletion_requests WHERE id = :id`, {
      id: toBin(id),
    }),
  );
}

export async function dueDeletions(db, limit) {
  const rows = await db.many(
    `SELECT ${DELETION_COLUMNS} FROM account_deletion_requests
      WHERE status = 'scheduled' AND scheduled_for <= NOW(3)
      ORDER BY scheduled_for LIMIT :limit`,
    { limit: String(limit) },
  );
  return rows.map(toDeletion);
}

export async function finishDeletion(db, id, { status, error }) {
  await db.run(
    `UPDATE account_deletion_requests
        SET status = :status, last_error = :error,
            completed_at = IF(:status = 'completed', NOW(3), completed_at)
      WHERE id = :id`,
    { id: toBin(id), status, error: error ? String(error).slice(0, 255) : null },
  );
}

export async function setUserStatus(db, conn, userId, status) {
  await db.run(
    'UPDATE users SET status = :status WHERE id = :userId',
    { userId: toBin(userId), status },
    conn,
  );
}

/** Silme sırasında dış servislere gereken kimlikler (satırlar silinmeden önce okunur). */
export async function firebaseSubjects(db, userId) {
  const rows = await db.many(
    `SELECT provider_subject FROM auth_identities
      WHERE user_id = :userId AND provider = 'firebase'`,
    { userId: toBin(userId) },
  );
  return rows.map((r) => r.provider_subject);
}

/**
 * Kişisel tablolar FK cascade ile gider; FK'siz izler ayrıca temizlenir/anonimleştirilir.
 * @returns silinen kullanıcı satırı sayısı
 */
export async function purgeUser(db, userId) {
  const id = toBin(userId);
  return db.withTransaction(async (conn) => {
    // FK SET NULL: sahipsiz kalmasın (dosyalar önceden silindi).
    await db.run('DELETE FROM media WHERE owner_user_id = :id', { id }, conn);
    await db.run(
      'DELETE FROM revenuecat_events WHERE app_user_id = :appUserId',
      {
        appUserId: userId,
      },
      conn,
    );
    // Denetim izi kalır ama kişiyle ilişkilendirilemez (06 §8.3).
    await db.run(
      `UPDATE audit_logs SET actor_id = NULL, ip = NULL, user_agent = NULL, metadata = NULL
        WHERE actor_type = 'user' AND actor_id = :id`,
      { id },
      conn,
    );
    await db.run(
      `UPDATE audit_logs SET entity_id = NULL, ip = NULL, user_agent = NULL, metadata = NULL
        WHERE entity_type = 'user' AND entity_id = :userId`,
      { userId },
      conn,
    );
    const result = await db.run('DELETE FROM users WHERE id = :id', { id }, conn);
    return result.affectedRows;
  });
}

// ── Dışa aktarma talepleri ────────────────────────────────────────────
const toExport = (r) =>
  r && {
    id: fromBin(r.id),
    userId: fromBin(r.user_id),
    status: r.status,
    mediaId: r.media_id ? fromBin(r.media_id) : null,
    bytes: r.bytes ?? null,
    requestedAt: r.requested_at,
    completedAt: r.completed_at ?? null,
    expiresAt: r.expires_at ?? null,
  };

const EXPORT_COLUMNS =
  'id, user_id, status, media_id, bytes, requested_at, completed_at, expires_at';

export async function insertExport(db, conn, userId) {
  const id = newId();
  await db.run(
    'INSERT INTO data_export_requests (id, user_id) VALUES (:id, :userId)',
    { id: toBin(id), userId: toBin(userId) },
    conn,
  );
  return id;
}

export async function findExport(db, id, conn) {
  return toExport(
    await db.one(
      `SELECT ${EXPORT_COLUMNS} FROM data_export_requests WHERE id = :id`,
      { id: toBin(id) },
      conn,
    ),
  );
}

/** Verilen andan beri istenen, başarısız olmamış son talep (günde 1 sınırı). */
export async function recentExport(db, conn, userId, since) {
  return toExport(
    await db.one(
      `SELECT ${EXPORT_COLUMNS} FROM data_export_requests
        WHERE user_id = :userId AND requested_at >= :since AND status <> 'failed'
        ORDER BY requested_at DESC LIMIT 1
        FOR UPDATE`,
      { userId: toBin(userId), since },
      conn,
    ),
  );
}

export async function setExportStatus(db, id, status, fields = {}) {
  await db.run(
    `UPDATE data_export_requests
        SET status = :status,
            media_id = COALESCE(:mediaId, media_id),
            bytes = COALESCE(:bytes, bytes),
            completed_at = IF(:status = 'ready', NOW(3), completed_at),
            expires_at = COALESCE(:expiresAt, expires_at),
            last_error = :error
      WHERE id = :id`,
    {
      id: toBin(id),
      status,
      mediaId: fields.mediaId ? toBin(fields.mediaId) : null,
      bytes: fields.bytes ?? null,
      expiresAt: fields.expiresAt ?? null,
      error: fields.error ? String(fields.error).slice(0, 255) : null,
    },
  );
}

export async function expiredExports(db, limit) {
  const rows = await db.many(
    `SELECT ${EXPORT_COLUMNS} FROM data_export_requests
      WHERE status = 'ready' AND expires_at <= NOW(3)
      ORDER BY expires_at LIMIT :limit`,
    { limit: String(limit) },
  );
  return rows.map(toExport);
}

// ── Rıza ──────────────────────────────────────────────────────────────
/** Türün son kaydı: true/false; hiç kayıt yoksa null. */
export async function latestConsent(db, userId, type) {
  const row = await db.one(
    `SELECT granted FROM user_consents
      WHERE user_id = :userId AND consent_type = :type
      ORDER BY created_at DESC LIMIT 1`,
    { userId: toBin(userId), type },
  );
  return row ? Boolean(row.granted) : null;
}
