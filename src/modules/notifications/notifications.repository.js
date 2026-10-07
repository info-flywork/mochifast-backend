import { DEFAULT_LOCALE } from '../../config/constants.js';
import { fromBin, newId, toBin } from '../../shared/ids.js';

// ── Şablonlar (process içinde 5 dk) ───────────────────────────────────
const TTL_MS = 5 * 60_000;
let templateCache = { at: 0, value: null };

export function resetTemplateCache() {
  templateCache = { at: 0, value: null };
}

/** type → {channel[], category, quietHours, maxDelayMin, priority, deepLink, iconKey, texts{locale}} */
export async function templates(db) {
  if (templateCache.value && Date.now() - templateCache.at < TTL_MS) return templateCache.value;
  const [rows, texts] = await Promise.all([
    db.many(
      `SELECT type, channel, category, quiet_hours, max_delay_min, priority, deep_link, icon_key
         FROM notification_templates WHERE is_active = 1`,
    ),
    db.many('SELECT type, locale, title, body FROM notification_template_translations'),
  ]);
  const value = {};
  for (const r of rows) {
    value[r.type] = {
      type: r.type,
      channel: String(r.channel).split(',').filter(Boolean),
      category: r.category,
      quietHours: r.quiet_hours,
      maxDelayMin: r.max_delay_min,
      priority: r.priority,
      deepLink: r.deep_link,
      iconKey: r.icon_key,
      texts: {},
    };
  }
  for (const t of texts) {
    if (value[t.type]) value[t.type].texts[t.locale] = { title: t.title, body: t.body };
  }
  templateCache = { at: Date.now(), value };
  return value;
}

export const textFor = (template, locale) =>
  template.texts[locale] ?? template.texts[DEFAULT_LOCALE] ?? { title: template.type, body: '' };

// ── Zamanlanmış ───────────────────────────────────────────────────────
const toScheduled = (r) =>
  r && {
    id: fromBin(r.id),
    userId: fromBin(r.user_id),
    type: r.type,
    fireAt: r.fire_at,
    params: r.params ? JSON.parse(r.params) : {},
    dedupeKey: r.dedupe_key,
    status: r.status,
    attempts: r.attempts,
  };

const SCHED_COLUMNS = `id, user_id, type, fire_at, CAST(params AS CHAR) AS params, dedupe_key, status,
                       attempts`;

/**
 * Vadesi gelenleri alır ve `processing` yapar (aynı satırı iki dispatcher almaz: SKIP LOCKED).
 */
export async function claimDue(db, limit) {
  return db.withTransaction(async (conn) => {
    const rows = await db.many(
      `SELECT ${SCHED_COLUMNS} FROM scheduled_notifications
        WHERE status = 'scheduled' AND fire_at <= NOW(3)
        ORDER BY fire_at LIMIT :limit
        FOR UPDATE SKIP LOCKED`,
      { limit: String(limit) },
      conn,
    );
    if (rows.length > 0) {
      const ids = rows.map((r, i) => [`i${i}`, r.id]);
      await db.run(
        `UPDATE scheduled_notifications SET status = 'processing', attempts = attempts + 1
          WHERE id IN (${ids.map(([k]) => `:${k}`).join(', ')})`,
        Object.fromEntries(ids),
        conn,
      );
    }
    return rows.map(toScheduled);
  });
}

export async function findScheduled(db, id) {
  return toScheduled(
    await db.one(`SELECT ${SCHED_COLUMNS} FROM scheduled_notifications WHERE id = :id`, {
      id: toBin(id),
    }),
  );
}

export async function finish(db, id, { status, error, category, pushed }) {
  await db.run(
    `UPDATE scheduled_notifications
        SET status = :status, last_error = :error, category = :category, pushed = :pushed,
            sent_at = IF(:status = 'sent', NOW(3), sent_at)
      WHERE id = :id`,
    {
      id: toBin(id),
      status,
      error: error ? String(error).slice(0, 255) : null,
      category: category ?? null,
      pushed: pushed ? 1 : 0,
    },
  );
}

/** Sessiz saat sonuna ertele (yeniden `scheduled`). */
export async function defer(db, id, fireAt, reason) {
  await db.run(
    `UPDATE scheduled_notifications SET status = 'scheduled', fire_at = :fireAt, last_error = :reason
      WHERE id = :id`,
    { id: toBin(id), fireAt, reason },
  );
}

/** Push gönderilmiş bildirim sayıları (verilen andan beri): toplam ve kategori bazında. */
export async function pushedSince(db, userId, since) {
  const rows = await db.many(
    `SELECT category, COUNT(*) AS n FROM scheduled_notifications
      WHERE user_id = :userId AND status = 'sent' AND pushed = 1 AND sent_at >= :since
      GROUP BY category`,
    { userId: toBin(userId), since },
  );
  const byCategory = Object.fromEntries(rows.map((r) => [r.category, Number(r.n)]));
  return { total: rows.reduce((a, r) => a + Number(r.n), 0), byCategory };
}

// ── Alıcı ─────────────────────────────────────────────────────────────
export async function recipient(db, userId) {
  const row = await db.one(
    `SELECT u.locale, u.timezone, u.created_at, u.display_name,
            s.push_enabled, s.notif_fasting, s.notif_streak, s.notif_weight, s.notif_water,
            s.notif_challenges, s.notif_world, s.notif_marketing,
            TIME_FORMAT(s.quiet_hours_start, '%H:%i') AS quiet_start,
            TIME_FORMAT(s.quiet_hours_end, '%H:%i') AS quiet_end
       FROM users u LEFT JOIN user_settings s ON s.user_id = u.id
      WHERE u.id = :userId AND u.deleted_at IS NULL AND u.status = 'active'`,
    { userId: toBin(userId) },
  );
  return row;
}

export async function pushDevices(db, userId) {
  const rows = await db.many(
    `SELECT id, push_token FROM devices
      WHERE user_id = :userId AND push_enabled = 1 AND push_token IS NOT NULL`,
    { userId: toBin(userId) },
  );
  return rows.map((r) => ({ id: fromBin(r.id), token: r.push_token }));
}

export async function clearToken(db, deviceId) {
  await db.run('UPDATE devices SET push_token = NULL WHERE id = :id', { id: toBin(deviceId) });
}

export async function recordDelivery(db, userId, d) {
  await db.run(
    `INSERT INTO push_deliveries (id, user_id, device_id, type, status, provider_message_id, error_code)
     VALUES (:id, :userId, :deviceId, :type, :status, :messageId, :errorCode)`,
    {
      id: toBin(newId()),
      userId: toBin(userId),
      deviceId: d.deviceId ? toBin(d.deviceId) : null,
      type: d.type,
      status: d.status,
      messageId: d.messageId ? String(d.messageId).slice(0, 160) : null,
      errorCode: d.errorCode ? String(d.errorCode).slice(0, 80) : null,
    },
  );
}

// ── Inbox ─────────────────────────────────────────────────────────────
export async function insertInbox(db, userId, { type, params, refType, refId }) {
  const id = newId();
  await db.run(
    `INSERT INTO notifications (id, user_id, type, params, ref_type, ref_id)
     VALUES (:id, :userId, :type, :params, :refType, :refId)`,
    {
      id: toBin(id),
      userId: toBin(userId),
      type,
      params: params ? JSON.stringify(params) : null,
      refType: refType ?? null,
      refId: refId ? toBin(refId) : null,
    },
  );
  return id;
}

export async function listInbox(db, userId, { before, limit }) {
  const rows = await db.many(
    `SELECT id, type, CAST(params AS CHAR) AS params, read_at, created_at FROM notifications
      WHERE user_id = :userId AND deleted_at IS NULL
        AND (:beforeAt IS NULL OR created_at < :beforeAt
             OR (created_at = :beforeAt AND id < :beforeId))
      ORDER BY created_at DESC, id DESC
      LIMIT :limit`,
    {
      userId: toBin(userId),
      beforeAt: before?.at ?? null,
      beforeId: before ? toBin(before.id) : null,
      limit: String(limit + 1),
    },
  );
  return rows.map((r) => ({
    id: fromBin(r.id),
    type: r.type,
    params: r.params ? JSON.parse(r.params) : {},
    readAt: r.read_at ?? null,
    createdAt: r.created_at,
  }));
}

export async function unreadCount(db, userId) {
  const row = await db.one(
    `SELECT COUNT(*) AS n FROM notifications
      WHERE user_id = :userId AND deleted_at IS NULL AND read_at IS NULL`,
    { userId: toBin(userId) },
  );
  return Number(row.n);
}

export async function markRead(db, userId, id) {
  const r = await db.run(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW(3))
      WHERE id = :id AND user_id = :userId AND deleted_at IS NULL`,
    { id: toBin(id), userId: toBin(userId) },
  );
  return r.affectedRows > 0;
}

export async function markAllRead(db, userId) {
  const r = await db.run(
    `UPDATE notifications SET read_at = NOW(3)
      WHERE user_id = :userId AND deleted_at IS NULL AND read_at IS NULL`,
    { userId: toBin(userId) },
  );
  return r.affectedRows;
}

export async function softDelete(db, userId, id) {
  const r = await db.run(
    `UPDATE notifications SET deleted_at = NOW(3)
      WHERE id = :id AND user_id = :userId AND deleted_at IS NULL`,
    { id: toBin(id), userId: toBin(userId) },
  );
  return r.affectedRows > 0;
}
