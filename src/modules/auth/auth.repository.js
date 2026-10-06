import { fromBin, newId, toBin } from '../../shared/ids.js';

/**
 * Kimlik/oturum SQL'i. Kimlikler dışarıya string UUID olarak verilir, DB'de BINARY(16).
 * Transaction içinde çağrılanlar `conn` alır.
 */

export async function findIdentity(db, conn, provider, subject) {
  const row = await db.one(
    `SELECT ai.id, ai.user_id, u.status, u.is_guest
       FROM auth_identities ai
       JOIN users u ON u.id = ai.user_id
      WHERE ai.provider = :provider AND ai.provider_subject = :subject
      FOR UPDATE`,
    { provider, subject },
    conn,
  );
  return row
    ? {
        id: fromBin(row.id),
        userId: fromBin(row.user_id),
        status: row.status,
        isGuest: row.is_guest,
      }
    : null;
}

export async function createUser(db, conn, user) {
  await db.run(
    `INSERT INTO users (id, is_guest, display_name, email, email_verified, locale, timezone)
     VALUES (:id, :isGuest, :displayName, :email, :emailVerified, :locale, :timezone)`,
    {
      id: toBin(user.id),
      isGuest: user.isGuest ? 1 : 0,
      displayName: user.displayName ?? null,
      email: user.email ?? null,
      emailVerified: user.emailVerified ? 1 : 0,
      locale: user.locale,
      timezone: user.timezone,
    },
    conn,
  );
}

export async function createIdentity(db, conn, identity) {
  await db.run(
    `INSERT INTO auth_identities
       (id, user_id, provider, provider_subject, email, apple_refresh_token_enc, last_login_at)
     VALUES (:id, :userId, :provider, :subject, :email, :appleRefreshEnc, NOW(3))`,
    {
      id: toBin(newId()),
      userId: toBin(identity.userId),
      provider: identity.provider,
      subject: identity.subject,
      email: identity.email ?? null,
      appleRefreshEnc: identity.appleRefreshEnc ?? null,
    },
    conn,
  );
}

/** Son giriş zamanı; yeni Apple refresh token geldiyse onu, e-posta geldiyse onu günceller. */
export async function touchIdentity(
  db,
  conn,
  identityId,
  { email = null, appleRefreshEnc = null } = {},
) {
  await db.run(
    `UPDATE auth_identities
        SET last_login_at = NOW(3),
            email = COALESCE(:email, email),
            apple_refresh_token_enc = COALESCE(:appleRefreshEnc, apple_refresh_token_enc)
      WHERE id = :id`,
    { id: toBin(identityId), email, appleRefreshEnc },
    conn,
  );
}

/** Misafir kimliği (installId) silinir: yükseltilen/terk edilen hesaba installId ile girilemez. */
export async function deleteGuestIdentities(db, conn, userId) {
  await db.run(
    "DELETE FROM auth_identities WHERE user_id = :userId AND provider = 'guest'",
    { userId: toBin(userId) },
    conn,
  );
}

export async function upgradeGuest(db, conn, userId, { displayName, email, emailVerified }) {
  await db.run(
    `UPDATE users
        SET is_guest = 0,
            display_name = COALESCE(display_name, :displayName),
            email = COALESCE(:email, email),
            email_verified = :emailVerified
      WHERE id = :id`,
    {
      id: toBin(userId),
      displayName: displayName ?? null,
      email: email ?? null,
      emailVerified: emailVerified ? 1 : 0,
    },
    conn,
  );
}

export async function setUserStatus(db, conn, userId, status) {
  await db.run(
    'UPDATE users SET status = :status WHERE id = :id',
    { id: toBin(userId), status },
    conn,
  );
}

export async function getUser(db, conn, userId) {
  const row = await db.one(
    `SELECT id, is_guest, display_name, email, locale, timezone, onboarding_completed_at, created_at
       FROM users WHERE id = :id`,
    { id: toBin(userId) },
    conn,
  );
  return row && { ...row, id: fromBin(row.id) };
}

/** Kullanıcı + kurulum için cihaz satırını oluşturur ya da günceller; cihaz kimliğini döner. */
export async function upsertDevice(db, conn, device) {
  const params = {
    id: toBin(newId()),
    userId: toBin(device.userId),
    installId: device.installId,
    platform: device.platform,
    osVersion: device.osVersion ?? null,
    appVersion: device.appVersion ?? null,
    deviceModel: device.deviceModel ?? null,
    locale: device.locale ?? null,
    timezone: device.timezone ?? null,
  };
  await db.run(
    `INSERT INTO devices
       (id, user_id, install_id, platform, os_version, app_version, device_model, locale, timezone, last_seen_at)
     VALUES (:id, :userId, :installId, :platform, :osVersion, :appVersion, :deviceModel, :locale, :timezone, NOW(3))
     ON DUPLICATE KEY UPDATE
       platform = VALUES(platform),
       os_version = COALESCE(VALUES(os_version), os_version),
       app_version = COALESCE(VALUES(app_version), app_version),
       device_model = COALESCE(VALUES(device_model), device_model),
       locale = COALESCE(VALUES(locale), locale),
       timezone = COALESCE(VALUES(timezone), timezone),
       last_seen_at = NOW(3)`,
    params,
    conn,
  );
  const row = await db.one(
    'SELECT id FROM devices WHERE user_id = :userId AND install_id = :installId',
    { userId: params.userId, installId: params.installId },
    conn,
  );
  return fromBin(row.id);
}

export async function insertSession(db, conn, session) {
  await db.run(
    `INSERT INTO sessions (id, user_id, device_id, family_id, token_hash, expires_at, ip, user_agent, last_used_at)
     VALUES (:id, :userId, :deviceId, :familyId, :tokenHash,
             DATE_ADD(NOW(3), INTERVAL :ttlDays DAY), INET6_ATON(:ip), :userAgent, NOW(3))`,
    {
      id: toBin(session.id),
      userId: toBin(session.userId),
      deviceId: session.deviceId ? toBin(session.deviceId) : null,
      familyId: toBin(session.familyId),
      tokenHash: session.tokenHash,
      ttlDays: session.ttlDays,
      ip: session.ip ?? null,
      userAgent: session.userAgent?.slice(0, 255) ?? null,
    },
    conn,
  );
}

/** Refresh token hash'iyle oturum (+ kullanıcı durumu), satır kilitli. */
export async function findSessionByHash(db, conn, tokenHash) {
  const row = await db.one(
    `SELECT s.id, s.user_id, s.device_id, s.family_id, s.revoked_at, s.revoke_reason,
            s.expires_at > NOW(3) AS live,
            s.revoked_at > NOW(3) - INTERVAL 10 SECOND AS rotated_recently,
            u.status AS user_status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = :tokenHash
      FOR UPDATE`,
    { tokenHash },
    conn,
  );
  return (
    row && {
      id: fromBin(row.id),
      userId: fromBin(row.user_id),
      deviceId: row.device_id ? fromBin(row.device_id) : null,
      familyId: fromBin(row.family_id),
      revoked: row.revoked_at !== null,
      revokeReason: row.revoke_reason,
      live: Boolean(row.live),
      rotatedRecently: Boolean(row.rotated_recently),
      userStatus: row.user_status,
    }
  );
}

export async function findSession(db, conn, userId, sessionId) {
  const row = await db.one(
    'SELECT family_id, device_id FROM sessions WHERE id = :id AND user_id = :userId',
    { id: toBin(sessionId), userId: toBin(userId) },
    conn,
  );
  return (
    row && {
      familyId: fromBin(row.family_id),
      deviceId: row.device_id ? fromBin(row.device_id) : null,
    }
  );
}

export async function markRotated(db, conn, sessionId, replacedById) {
  await db.run(
    `UPDATE sessions
        SET revoked_at = NOW(3), revoke_reason = 'rotated', replaced_by_id = :replacedBy,
            last_used_at = NOW(3)
      WHERE id = :id`,
    { id: toBin(sessionId), replacedBy: toBin(replacedById) },
    conn,
  );
}

/**
 * Bir oturum ailesini iptal eder; etkilenen satır sayısını döner. `userId` sahiplik kontrolüdür.
 * "rotated" satırlar da kapsanır: aile iptal edilince eski access token'lar da reddedilir.
 */
export async function revokeFamily(db, conn, { familyId, userId }, reason) {
  const result = await db.run(
    `UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, NOW(3)), revoke_reason = :reason
      WHERE family_id = :familyId AND user_id = :userId AND (revoke_reason IS NULL OR revoke_reason = 'rotated')`,
    { familyId: toBin(familyId), userId: toBin(userId), reason },
    conn,
  );
  return result.affectedRows;
}

export async function revokeUserSessions(db, conn, userId, reason) {
  await db.run(
    `UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, NOW(3)), revoke_reason = :reason
      WHERE user_id = :userId AND (revoke_reason IS NULL OR revoke_reason = 'rotated')`,
    { userId: toBin(userId), reason },
    conn,
  );
}

/** Çıkışta push token'ı silinir (deviceId null → kullanıcının tüm cihazları). */
export async function clearPushTokens(db, conn, userId, deviceId) {
  await db.run(
    `UPDATE devices SET push_token = NULL
      WHERE user_id = :userId AND (:deviceId IS NULL OR id = :deviceId)`,
    { userId: toBin(userId), deviceId: deviceId ? toBin(deviceId) : null },
    conn,
  );
}

/** Aktif oturum aileleri (her ailenin güncel satırı), son kullanılana göre. */
export async function listActiveSessions(db, userId) {
  const rows = await db.many(
    `SELECT s.family_id, s.last_used_at, d.platform, d.device_model, d.app_version,
            (SELECT MIN(f.created_at) FROM sessions f WHERE f.family_id = s.family_id) AS signed_in_at
       FROM sessions s
       LEFT JOIN devices d ON d.id = s.device_id
      WHERE s.user_id = :userId AND s.revoked_at IS NULL AND s.expires_at > NOW(3)
      ORDER BY s.last_used_at DESC`,
    { userId: toBin(userId) },
  );
  return rows.map((r) => ({ ...r, family_id: fromBin(r.family_id) }));
}
