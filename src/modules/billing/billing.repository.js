import { fromBin, newId, toBin } from '../../shared/ids.js';

const COLUMNS = `user_id, entitlement, product_id, store, environment, period_type, status,
                 will_renew, purchased_at, expires_at, grace_expires_at, management_url,
                 last_synced_at`;

const toSubscription = (r) =>
  r && {
    userId: fromBin(r.user_id),
    entitlement: r.entitlement,
    productId: r.product_id ?? null,
    store: r.store ?? null,
    environment: r.environment,
    periodType: r.period_type ?? null,
    status: r.status,
    willRenew: Boolean(r.will_renew),
    purchasedAt: r.purchased_at ?? null,
    expiresAt: r.expires_at ?? null,
    graceExpiresAt: r.grace_expires_at ?? null,
    managementUrl: r.management_url ?? null,
    lastSyncedAt: r.last_synced_at,
  };

export async function findSubscription(db, userId, entitlement, conn) {
  return toSubscription(
    await db.one(
      `SELECT ${COLUMNS} FROM subscriptions WHERE user_id = :userId AND entitlement = :entitlement`,
      { userId: toBin(userId), entitlement },
      conn,
    ),
  );
}

export async function upsertSubscription(db, conn, userId, entitlement, s) {
  await db.run(
    `INSERT INTO subscriptions
       (id, user_id, entitlement, product_id, store, environment, period_type, status, will_renew,
        purchased_at, expires_at, grace_expires_at, management_url, last_synced_at)
     VALUES (:id, :userId, :entitlement, :productId, :store, :environment, :periodType, :status,
             :willRenew, :purchasedAt, :expiresAt, :graceExpiresAt, :managementUrl, NOW(3))
     ON DUPLICATE KEY UPDATE product_id = VALUES(product_id), store = VALUES(store),
       environment = VALUES(environment), period_type = VALUES(period_type),
       status = VALUES(status), will_renew = VALUES(will_renew),
       purchased_at = VALUES(purchased_at), expires_at = VALUES(expires_at),
       grace_expires_at = VALUES(grace_expires_at), management_url = VALUES(management_url),
       last_synced_at = NOW(3)`,
    {
      id: toBin(newId()),
      userId: toBin(userId),
      entitlement,
      productId: s.productId,
      store: s.store,
      environment: s.environment,
      periodType: s.periodType,
      status: s.status,
      willRenew: s.willRenew ? 1 : 0,
      purchasedAt: s.purchasedAt,
      expiresAt: s.expiresAt,
      graceExpiresAt: s.graceExpiresAt,
      managementUrl: s.managementUrl,
    },
    conn,
  );
}

/** Entitlement artık yoksa (RevenueCat'te iz kalmadı) kayıt `expired` olur. */
export async function expireSubscription(db, conn, userId, entitlement) {
  await db.run(
    `UPDATE subscriptions SET status = 'expired', will_renew = 0, last_synced_at = NOW(3)
      WHERE user_id = :userId AND entitlement = :entitlement`,
    { userId: toBin(userId), entitlement },
    conn,
  );
}

/** @returns true: yeni olay; false: daha önce alınmış (tekrar). */
export async function insertEvent(db, e) {
  const r = await db.run(
    `INSERT IGNORE INTO revenuecat_events (event_id, event_type, app_user_id, environment, payload)
     VALUES (:id, :type, :appUserId, :environment, :payload)`,
    {
      id: e.id,
      type: e.type,
      appUserId: e.appUserId,
      environment: e.environment,
      payload: JSON.stringify(e.payload),
    },
  );
  return r.affectedRows === 1;
}

export async function findEvent(db, eventId) {
  const r = await db.one(
    `SELECT event_id, event_type, app_user_id, environment, CAST(payload AS CHAR) AS payload,
            processed_at
       FROM revenuecat_events WHERE event_id = :id`,
    { id: eventId },
  );
  return r && { ...r, payload: JSON.parse(r.payload) };
}

export async function markEvent(db, eventId, error = null) {
  await db.run(
    'UPDATE revenuecat_events SET processed_at = NOW(3), error = :error WHERE event_id = :id',
    { id: eventId, error: error ? String(error).slice(0, 255) : null },
  );
}

export async function userExists(db, userId) {
  return Boolean(
    await db.one('SELECT id FROM users WHERE id = :id AND deleted_at IS NULL', {
      id: toBin(userId),
    }),
  );
}

export async function insertNotification(db, conn, userId, { type, params, refType, refId }) {
  await db.run(
    `INSERT INTO notifications (id, user_id, type, params, ref_type, ref_id)
     VALUES (:id, :userId, :type, :params, :refType, :refId)`,
    {
      id: toBin(newId()),
      userId: toBin(userId),
      type,
      params: params ? JSON.stringify(params) : null,
      refType: refType ?? null,
      refId: refId ? toBin(refId) : null,
    },
    conn,
  );
}

/**
 * Aktif planı premium olup premium erişimi bitmiş kullanıcılar (premium kaybı akışı, 11 §5):
 * aboneliği `expired`/`refunded` ve bitişi en az `graceHours` önce.
 */
export async function premiumPlansWithoutAccess(db, entitlement, graceHours, limit) {
  const rows = await db.many(
    `SELECT up.user_id, p.code AS plan_code, s.expires_at, u.timezone
       FROM user_plans up
       JOIN fasting_plans p ON p.id = up.plan_id AND p.is_premium = 1
       JOIN subscriptions s ON s.user_id = up.user_id AND s.entitlement = :entitlement
       JOIN users u ON u.id = up.user_id
      WHERE up.ended_at IS NULL AND s.status IN ('expired', 'refunded')
        AND COALESCE(s.expires_at, s.last_synced_at) < DATE_SUB(NOW(3), INTERVAL :hours HOUR)
      LIMIT :limit`,
    { entitlement, hours: graceHours, limit: String(limit) },
  );
  return rows.map((r) => ({
    userId: fromBin(r.user_id),
    planCode: r.plan_code,
    expiresAt: r.expires_at,
    timezone: r.timezone,
  }));
}
