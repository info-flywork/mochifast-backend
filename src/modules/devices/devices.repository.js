import { fromBin, newId, toBin } from '../../shared/ids.js';

/**
 * Cihaz kaydı (her açılışta ve push token değişince). `pushToken: undefined` → dokunulmaz,
 * `null` → silinir.
 */
export async function upsertCurrentDevice(db, conn, userId, d) {
  const tokenGiven = d.pushToken !== undefined;
  const params = {
    id: toBin(newId()),
    userId: toBin(userId),
    installId: d.installId,
    platform: d.platform,
    osVersion: d.osVersion ?? null,
    appVersion: d.appVersion ?? null,
    deviceModel: d.deviceModel ?? null,
    pushToken: d.pushToken ?? null,
    tokenGiven: tokenGiven ? 1 : 0,
    pushEnabled: d.pushEnabled === undefined ? null : d.pushEnabled ? 1 : 0,
    locale: d.locale ?? null,
    timezone: d.timezone ?? null,
  };
  await db.run(
    `INSERT INTO devices
       (id, user_id, install_id, platform, os_version, app_version, device_model,
        push_token, push_enabled, locale, timezone, last_seen_at)
     VALUES (:id, :userId, :installId, :platform, :osVersion, :appVersion, :deviceModel,
             :pushToken, COALESCE(:pushEnabled, 1), :locale, :timezone, NOW(3))
     ON DUPLICATE KEY UPDATE
       platform = VALUES(platform),
       os_version = COALESCE(VALUES(os_version), os_version),
       app_version = COALESCE(VALUES(app_version), app_version),
       device_model = COALESCE(VALUES(device_model), device_model),
       push_token = IF(:tokenGiven = 1, VALUES(push_token), push_token),
       push_enabled = COALESCE(:pushEnabled, push_enabled),
       locale = COALESCE(VALUES(locale), locale),
       timezone = COALESCE(VALUES(timezone), timezone),
       last_seen_at = NOW(3)`,
    params,
    conn,
  );
  const row = await db.one(
    `SELECT id, install_id, platform, push_token IS NOT NULL AS has_push_token, push_enabled
       FROM devices WHERE user_id = :userId AND install_id = :installId`,
    { userId: params.userId, installId: d.installId },
    conn,
  );
  return { ...row, id: fromBin(row.id) };
}

/** Aynı push token başka bir satırda (ör. telefonda hesap değişti) kaldıysa temizlenir. */
export async function releasePushToken(db, conn, pushToken, keepDeviceId) {
  await db.run(
    'UPDATE devices SET push_token = NULL WHERE push_token = :pushToken AND id <> :keep',
    { pushToken, keep: toBin(keepDeviceId) },
    conn,
  );
}

/** Oturum ailesini cihaza bağlar (misafir girişi cihazsız açılmış olabilir). */
export async function attachSessionDevice(db, conn, userId, sessionId, deviceId) {
  await db.run(
    `UPDATE sessions s
       JOIN sessions cur ON cur.family_id = s.family_id
        SET s.device_id = :deviceId
      WHERE cur.id = :sessionId AND cur.user_id = :userId AND s.user_id = :userId`,
    { deviceId: toBin(deviceId), sessionId: toBin(sessionId), userId: toBin(userId) },
    conn,
  );
}

/** Oturumun cihazı; yoksa installId ile. */
export async function findCurrentDeviceId(db, userId, sessionId, installId) {
  const row = await db.one(
    `SELECT COALESCE(
              (SELECT s.device_id FROM sessions s WHERE s.id = :sessionId AND s.user_id = :userId),
              (SELECT d.id FROM devices d WHERE d.user_id = :userId AND d.install_id = :installId)
            ) AS id`,
    { sessionId: toBin(sessionId), userId: toBin(userId), installId: installId ?? '' },
  );
  return row?.id ? fromBin(row.id) : null;
}

export async function clearPushToken(db, userId, deviceId) {
  await db.run('UPDATE devices SET push_token = NULL WHERE id = :id AND user_id = :userId', {
    id: toBin(deviceId),
    userId: toBin(userId),
  });
}
