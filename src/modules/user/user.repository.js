import { fromBin, newId, toBin } from '../../shared/ids.js';

/**
 * Kullanıcı/profil SQL'i. Kolon adları yalnızca aşağıdaki sabit listelerden gelir
 * (kullanıcı girdisi asla tanımlayıcı olmaz); değerler her zaman placeholder.
 */

const PROFILE_COLUMNS = [
  'gender',
  'birth_year',
  'height_cm',
  'start_weight_kg',
  'goal_weight_kg',
  'goal',
  'diet',
  'weight_history',
  'fasting_reason',
  'target_date',
  'weekly_loss_target_kg',
  'meal_window_start',
  'meal_window_end',
  'plan_code',
  'health_flags',
  'health_screened_at',
  'weight_unit',
  'height_unit',
  'water_unit',
];

const SETTINGS_COLUMNS = [
  'push_enabled',
  'notif_fasting',
  'notif_streak',
  'notif_weight',
  'notif_water',
  'notif_challenges',
  'notif_world',
  'notif_marketing',
  'water_reminder_interval_min',
  'quiet_hours_start',
  'quiet_hours_end',
  'health_sync_enabled',
  'show_in_challenges',
];

const GOALS_COLUMNS = [
  'water_goal_ml',
  'glass_size_ml',
  'custom_glass_sizes',
  'steps_goal',
  'kcal_goal',
  'protein_goal_g',
  'carbs_goal_g',
  'fat_goal_g',
  'sleep_goal_min',
  'bedtime',
  'wake_time',
];

/** `fields` içindeki whitelist kolonlarıyla upsert SQL'i ve parametreleri üretir. */
function upsertSql(table, allowed, userId, fields) {
  const cols = Object.keys(fields).filter((c) => allowed.includes(c));
  const params = { userId: toBin(userId) };
  for (const c of cols) params[c] = fields[c];
  if (cols.length === 0) {
    return {
      sql: `INSERT INTO ${table} (user_id) VALUES (:userId) ON DUPLICATE KEY UPDATE user_id = user_id`,
      params,
    };
  }
  const sql =
    `INSERT INTO ${table} (user_id, ${cols.join(', ')}) ` +
    `VALUES (:userId, ${cols.map((c) => `:${c}`).join(', ')}) ` +
    `ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`;
  return { sql, params };
}

async function upsert(db, conn, table, allowed, userId, fields) {
  const { sql, params } = upsertSql(table, allowed, userId, fields);
  await db.run(sql, params, conn);
}

export const upsertProfile = (db, conn, userId, fields) =>
  upsert(db, conn, 'user_profiles', PROFILE_COLUMNS, userId, fields);
export const upsertSettings = (db, conn, userId, fields) =>
  upsert(db, conn, 'user_settings', SETTINGS_COLUMNS, userId, fields);
export const upsertGoals = (db, conn, userId, fields) =>
  upsert(db, conn, 'user_goals', GOALS_COLUMNS, userId, fields);

/** Ayar/hedef/istatistik satırları yoksa varsayılanlarla oluşturulur (varsa dokunulmaz). */
export async function ensureDefaults(db, conn, userId) {
  for (const table of ['user_settings', 'user_goals', 'user_stats']) {
    await upsert(db, conn, table, [], userId, {});
  }
}

export async function getUserWithUnits(db, userId, conn) {
  const row = await db.one(
    `SELECT u.id, u.is_guest, u.display_name, u.email, u.locale, u.timezone,
            u.onboarding_completed_at, u.created_at,
            COALESCE(p.weight_unit, 'kg') AS weight_unit,
            COALESCE(p.height_unit, 'cm') AS height_unit,
            COALESCE(p.water_unit, 'ml') AS water_unit
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = :id`,
    { id: toBin(userId) },
    conn,
  );
  return row && { ...row, id: fromBin(row.id) };
}

export async function updateUser(db, conn, userId, { displayName, locale, timezone }) {
  await db.run(
    `UPDATE users
        SET display_name = COALESCE(:displayName, display_name),
            locale = COALESCE(:locale, locale),
            timezone = COALESCE(:timezone, timezone)
      WHERE id = :id`,
    {
      id: toBin(userId),
      displayName: displayName ?? null,
      locale: locale ?? null,
      timezone: timezone ?? null,
    },
    conn,
  );
}

export async function markOnboarded(db, conn, userId) {
  await db.run(
    'UPDATE users SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW(3)) WHERE id = :id',
    { id: toBin(userId) },
    conn,
  );
}

/** Ana sayfa / kilo kartı: profil + son kilo; yiyecek/engel listeleri yok (ekstra 2 RTT). */
export async function getProfileCore(db, userId, conn) {
  return db.one(
    `SELECT p.gender, p.birth_year, p.height_cm, p.start_weight_kg, p.goal_weight_kg, p.goal,
            p.diet, p.weekly_loss_target_kg, p.plan_code, p.health_flags,
            p.weight_unit, p.height_unit, p.water_unit,
            (SELECT w.weight_kg FROM weight_entries w
              WHERE w.user_id = p.user_id AND w.deleted_at IS NULL
              ORDER BY w.recorded_at DESC, w.id DESC LIMIT 1) AS current_weight_kg
       FROM user_profiles p
      WHERE p.user_id = :id`,
    { id: toBin(userId) },
    conn,
  );
}

/** Profil + son kilo (silinmemiş en yeni kayıt). `forUpdate` ile satır kilitlenir. */
export async function getProfile(db, userId, conn, { forUpdate = false } = {}) {
  const row = await db.one(
    `SELECT p.*,
            (SELECT w.weight_kg FROM weight_entries w
              WHERE w.user_id = p.user_id AND w.deleted_at IS NULL
              ORDER BY w.recorded_at DESC, w.id DESC LIMIT 1) AS current_weight_kg
       FROM user_profiles p
      WHERE p.user_id = :id${forUpdate ? ' FOR UPDATE' : ''}`,
    { id: toBin(userId) },
    conn,
  );
  if (!row) return null;
  // Tercih / engel listeleri birbirinden bağımsız — uzak DB'de sırayla gitmesin.
  const [prefs, obstacles] = await Promise.all([
    db.many(
      'SELECT pref_type, food_code FROM user_food_preferences WHERE user_id = :id ORDER BY created_at, food_code',
      { id: toBin(userId) },
      conn,
    ),
    db.many(
      'SELECT obstacle FROM user_obstacles WHERE user_id = :id ORDER BY obstacle',
      { id: toBin(userId) },
      conn,
    ),
  ]);
  return {
    ...row,
    food_loves: prefs.filter((p) => p.pref_type === 'love').map((p) => p.food_code),
    food_skips: prefs.filter((p) => p.pref_type === 'skip').map((p) => p.food_code),
    obstacles: obstacles.map((o) => o.obstacle),
  };
}

export async function replaceFoodPreferences(db, conn, userId, prefType, codes) {
  await db.run(
    'DELETE FROM user_food_preferences WHERE user_id = :id AND pref_type = :prefType',
    { id: toBin(userId), prefType },
    conn,
  );
  for (const code of new Set(codes)) {
    await db.run(
      'INSERT INTO user_food_preferences (user_id, pref_type, food_code) VALUES (:id, :prefType, :code)',
      { id: toBin(userId), prefType, code },
      conn,
    );
  }
}

export async function replaceObstacles(db, conn, userId, obstacles) {
  await db.run('DELETE FROM user_obstacles WHERE user_id = :id', { id: toBin(userId) }, conn);
  for (const obstacle of new Set(obstacles)) {
    await db.run(
      'INSERT INTO user_obstacles (user_id, obstacle) VALUES (:id, :obstacle)',
      { id: toBin(userId), obstacle },
      conn,
    );
  }
}

export async function insertSubmission(db, conn, userId, schemaVersion, payload) {
  await db.run(
    `INSERT INTO onboarding_submissions (id, user_id, schema_version, payload)
     VALUES (:id, :userId, :schemaVersion, :payload)`,
    { id: toBin(newId()), userId: toBin(userId), schemaVersion, payload: JSON.stringify(payload) },
    conn,
  );
}

/**
 * Onboarding kilosu: kullanıcı başına tek kayıt; onboarding tekrar gönderilirse güncellenir.
 */
export async function upsertOnboardingWeight(db, conn, userId, { weightKg, localDate, tz }) {
  const existing = await db.one(
    "SELECT id FROM weight_entries WHERE user_id = :id AND source = 'onboarding' AND deleted_at IS NULL",
    { id: toBin(userId) },
    conn,
  );
  if (existing) {
    await db.run(
      'UPDATE weight_entries SET weight_kg = :weightKg WHERE id = :entryId',
      { entryId: existing.id, weightKg },
      conn,
    );
    return;
  }
  await insertWeight(db, conn, userId, { weightKg, localDate, tz, source: 'onboarding' });
}

export async function insertWeight(
  db,
  conn,
  userId,
  { weightKg, localDate, tz, source = 'manual' },
) {
  await db.run(
    `INSERT INTO weight_entries (id, user_id, weight_kg, recorded_at, local_date, tz, source)
     VALUES (:id, :userId, :weightKg, NOW(3), :localDate, :tz, :source)`,
    { id: toBin(newId()), userId: toBin(userId), weightKg, localDate, tz, source },
    conn,
  );
}

export async function insertConsents(db, conn, userId, consents, { ip, source }) {
  for (const c of consents) {
    await db.run(
      `INSERT INTO user_consents (id, user_id, consent_type, document_version, granted, source, ip)
       VALUES (:id, :userId, :type, :version, :granted, :source, INET6_ATON(:ip))`,
      {
        id: toBin(newId()),
        userId: toBin(userId),
        type: c.type,
        version: c.version,
        granted: c.granted ? 1 : 0,
        source,
        ip: ip ?? null,
      },
      conn,
    );
  }
}

/** Her rıza türü için en son kayıt (append-only tablodan geçerli durum). */
export async function latestConsents(db, userId) {
  // Window: alt sorgu + self-join yerine tek tarama (uzak DB round-trip / CPU).
  return db.many(
    `SELECT consent_type, document_version, granted, created_at
       FROM (
         SELECT consent_type, document_version, granted, created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY consent_type ORDER BY created_at DESC
                ) AS rn
           FROM user_consents
          WHERE user_id = :id
       ) ranked
      WHERE rn = 1
      ORDER BY consent_type`,
    { id: toBin(userId) },
  );
}

export async function getSettings(db, userId) {
  return db.one(`SELECT ${SETTINGS_COLUMNS.join(', ')} FROM user_settings WHERE user_id = :id`, {
    id: toBin(userId),
  });
}

export async function getGoals(db, userId) {
  return db.one(`SELECT ${GOALS_COLUMNS.join(', ')} FROM user_goals WHERE user_id = :id`, {
    id: toBin(userId),
  });
}
