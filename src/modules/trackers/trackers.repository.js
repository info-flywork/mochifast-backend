import { fromBin, toBin } from '../../shared/ids.js';
import { isoDate } from '../../shared/time.js';

/**
 * Kilo, su, adım ve uyku kayıtları. Sahiplik her sorguda `user_id` ile sınırlanır; başka
 * kullanıcının kaydı "yok" gibi davranır (varlığı sızdırılmaz).
 */

// ── Kilo ──────────────────────────────────────────────────────────────
const toWeight = (r) =>
  r && {
    id: fromBin(r.id),
    weightKg: Number(r.weight_kg),
    recordedAt: r.recorded_at,
    localDate: isoDate(r.local_date),
    source: r.source,
  };

const WEIGHT_COLUMNS = 'id, weight_kg, recorded_at, local_date, source';

/** Kaydı id ile bulur. Başka kullanıcınınsa `{ foreign: true }` (istemci id çakışması). */
export async function findWeight(db, userId, id, conn, { includeDeleted = false } = {}) {
  const row = await db.one(
    `SELECT ${WEIGHT_COLUMNS}, user_id, deleted_at FROM weight_entries WHERE id = :id`,
    { id: toBin(id) },
    conn,
  );
  if (!row) return null;
  if (fromBin(row.user_id) !== userId) return { foreign: true };
  if (row.deleted_at && !includeDeleted) return null;
  return toWeight(row);
}

export async function insertWeight(db, conn, userId, e) {
  await db.run(
    `INSERT INTO weight_entries (id, user_id, weight_kg, recorded_at, local_date, tz, source)
     VALUES (:id, :userId, :weightKg, :recordedAt, :localDate, :tz, :source)`,
    {
      id: toBin(e.id),
      userId: toBin(userId),
      weightKg: e.weightKg,
      recordedAt: e.recordedAt,
      localDate: e.localDate,
      tz: e.tz,
      source: e.source,
    },
    conn,
  );
}

export async function updateWeight(db, conn, id, { weightKg, recordedAt, localDate }) {
  await db.run(
    `UPDATE weight_entries SET weight_kg = :weightKg, recorded_at = :recordedAt,
            local_date = :localDate
      WHERE id = :id`,
    { id: toBin(id), weightKg, recordedAt, localDate },
    conn,
  );
}

export async function softDeleteWeight(db, conn, id) {
  await db.run(
    'UPDATE weight_entries SET deleted_at = NOW(3) WHERE id = :id',
    { id: toBin(id) },
    conn,
  );
}

/** En yeni önce; imleç (recorded_at, id). */
export async function listWeights(db, userId, { from, to, before, limit }) {
  const rows = await db.many(
    `SELECT ${WEIGHT_COLUMNS} FROM weight_entries
      WHERE user_id = :userId AND deleted_at IS NULL
        AND (:from IS NULL OR local_date >= :from) AND (:to IS NULL OR local_date <= :to)
        AND (:beforeAt IS NULL OR recorded_at < :beforeAt
             OR (recorded_at = :beforeAt AND id < :beforeId))
      ORDER BY recorded_at DESC, id DESC
      LIMIT :limit`,
    {
      userId: toBin(userId),
      from: from ?? null,
      to: to ?? null,
      beforeAt: before?.at ?? null,
      beforeId: before ? toBin(before.id) : null,
      limit: String(limit + 1),
    },
  );
  return rows.map(toWeight);
}

/** Aralıktaki ölçümler, eskiden yeniye (grafik kovaları). */
export async function weightsBetween(db, userId, { from, to }) {
  const rows = await db.many(
    `SELECT ${WEIGHT_COLUMNS} FROM weight_entries
      WHERE user_id = :userId AND deleted_at IS NULL AND local_date BETWEEN :from AND :to
      ORDER BY recorded_at, id`,
    { userId: toBin(userId), from, to },
  );
  return rows.map(toWeight);
}

export async function latestWeight(db, userId) {
  const row = await db.one(
    `SELECT ${WEIGHT_COLUMNS} FROM weight_entries
      WHERE user_id = :userId AND deleted_at IS NULL
      ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    { userId: toBin(userId) },
  );
  return toWeight(row);
}

// ── Su ────────────────────────────────────────────────────────────────
const toWater = (r) =>
  r && {
    id: fromBin(r.id),
    amountMl: r.amount_ml,
    loggedAt: r.logged_at,
    localDate: isoDate(r.local_date),
    source: r.source,
  };

export async function findWater(db, userId, id, conn, { includeDeleted = false } = {}) {
  const row = await db.one(
    `SELECT id, user_id, amount_ml, logged_at, local_date, source, deleted_at
       FROM water_entries WHERE id = :id`,
    { id: toBin(id) },
    conn,
  );
  if (!row) return null;
  if (fromBin(row.user_id) !== userId) return { foreign: true };
  if (row.deleted_at && !includeDeleted) return null;
  return toWater(row);
}

export async function insertWater(db, conn, userId, e) {
  await db.run(
    `INSERT INTO water_entries (id, user_id, amount_ml, logged_at, local_date, tz, source)
     VALUES (:id, :userId, :amountMl, :loggedAt, :localDate, :tz, :source)`,
    {
      id: toBin(e.id),
      userId: toBin(userId),
      amountMl: e.amountMl,
      loggedAt: e.loggedAt,
      localDate: e.localDate,
      tz: e.tz,
      source: e.source,
    },
    conn,
  );
}

export async function softDeleteWater(db, conn, id) {
  await db.run(
    'UPDATE water_entries SET deleted_at = NOW(3) WHERE id = :id',
    { id: toBin(id) },
    conn,
  );
}

export async function waterOfDay(db, userId, date, conn) {
  const rows = await db.many(
    `SELECT id, amount_ml, logged_at, local_date, source FROM water_entries
      WHERE user_id = :userId AND local_date = :date AND deleted_at IS NULL
      ORDER BY logged_at, id`,
    { userId: toBin(userId), date },
    conn,
  );
  return rows.map(toWater);
}

// ── Günlük özet ve hedefler ───────────────────────────────────────────
/** Aralıktaki özet satırları (takipçi sütunları), tarihe göre Map. */
export async function summariesBetween(db, userId, { from, to }, conn) {
  const rows = await db.many(
    `SELECT local_date, water_ml, water_goal_ml, steps, steps_goal, sleep_minutes, sleep_goal_min,
            weight_kg, kcal, protein_g, carbs_g, fat_g, meals_count, snacks_count,
            hunger_physical, hunger_emotional, fasted_minutes
       FROM daily_summaries WHERE user_id = :userId AND local_date BETWEEN :from AND :to`,
    { userId: toBin(userId), from, to },
    conn,
  );
  return new Map(rows.map((r) => [isoDate(r.local_date), r]));
}

export async function goals(db, userId, conn) {
  return db.one(
    `SELECT water_goal_ml, glass_size_ml, steps_goal, sleep_goal_min, bedtime, wake_time
       FROM user_goals WHERE user_id = :userId`,
    { userId: toBin(userId) },
    conn,
  );
}

// ── Adım ──────────────────────────────────────────────────────────────
export async function findSteps(db, userId, date, conn, { forUpdate = false } = {}) {
  return db.one(
    `SELECT local_date, steps, distance_m, active_kcal, source FROM step_daily
      WHERE user_id = :userId AND local_date = :date${forUpdate ? ' FOR UPDATE' : ''}`,
    { userId: toBin(userId), date },
    conn,
  );
}

export async function upsertSteps(db, conn, userId, d) {
  await db.run(
    `INSERT INTO step_daily (user_id, local_date, steps, distance_m, active_kcal, source)
     VALUES (:userId, :date, :steps, :distanceM, :activeKcal, :source)
     ON DUPLICATE KEY UPDATE steps = VALUES(steps), distance_m = VALUES(distance_m),
       active_kcal = VALUES(active_kcal), source = VALUES(source)`,
    {
      userId: toBin(userId),
      date: d.date,
      steps: d.steps,
      distanceM: d.distanceM ?? null,
      activeKcal: d.activeKcal ?? null,
      source: d.source,
    },
    conn,
  );
}

export async function stepsBetween(db, userId, { from, to }) {
  const rows = await db.many(
    `SELECT local_date, steps, distance_m, active_kcal, source FROM step_daily
      WHERE user_id = :userId AND local_date BETWEEN :from AND :to`,
    { userId: toBin(userId), from, to },
  );
  return new Map(rows.map((r) => [isoDate(r.local_date), r]));
}

// ── Uyku ──────────────────────────────────────────────────────────────
const toSleep = (r) =>
  r && {
    id: fromBin(r.id),
    sleepStart: r.sleep_start,
    sleepEnd: r.sleep_end,
    durationMinutes: r.duration_minutes,
    localDate: isoDate(r.local_date),
    quality: r.quality ?? null,
    source: r.source,
  };

const SLEEP_COLUMNS =
  'id, sleep_start, sleep_end, duration_minutes, local_date, quality, source, external_id';

export async function findSleep(db, userId, id, conn, { includeDeleted = false } = {}) {
  const row = await db.one(
    `SELECT ${SLEEP_COLUMNS}, user_id, deleted_at FROM sleep_entries WHERE id = :id`,
    { id: toBin(id) },
    conn,
  );
  if (!row) return null;
  if (fromBin(row.user_id) !== userId) return { foreign: true };
  if (row.deleted_at && !includeDeleted) return null;
  return toSleep(row);
}

export async function findSleepByExternal(db, conn, userId, source, externalId) {
  const row = await db.one(
    `SELECT ${SLEEP_COLUMNS} FROM sleep_entries
      WHERE user_id = :userId AND source = :source AND external_id = :externalId`,
    { userId: toBin(userId), source, externalId },
    conn,
  );
  return toSleep(row);
}

/** Aralıkla çakışan (silinmemiş) uyku kayıtları. */
export async function overlappingSleep(db, conn, userId, start, end, excludeId) {
  const rows = await db.many(
    `SELECT id FROM sleep_entries
      WHERE user_id = :userId AND deleted_at IS NULL
        AND sleep_start < :end AND sleep_end > :start
        AND (:excludeId IS NULL OR id <> :excludeId)
      FOR UPDATE`,
    { userId: toBin(userId), start, end, excludeId: excludeId ? toBin(excludeId) : null },
    conn,
  );
  return rows.map((r) => fromBin(r.id));
}

export async function insertSleep(db, conn, userId, e) {
  await db.run(
    `INSERT INTO sleep_entries
       (id, user_id, sleep_start, sleep_end, duration_minutes, local_date, tz, quality, source,
        external_id)
     VALUES (:id, :userId, :start, :end, :minutes, :localDate, :tz, :quality, :source, :externalId)`,
    {
      id: toBin(e.id),
      userId: toBin(userId),
      start: e.sleepStart,
      end: e.sleepEnd,
      minutes: e.durationMinutes,
      localDate: e.localDate,
      tz: e.tz,
      quality: e.quality ?? null,
      source: e.source,
      externalId: e.externalId ?? null,
    },
    conn,
  );
}

export async function updateSleep(db, conn, id, e) {
  await db.run(
    `UPDATE sleep_entries
        SET sleep_start = :start, sleep_end = :end, duration_minutes = :minutes,
            local_date = :localDate, quality = :quality, deleted_at = NULL
      WHERE id = :id`,
    {
      id: toBin(id),
      start: e.sleepStart,
      end: e.sleepEnd,
      minutes: e.durationMinutes,
      localDate: e.localDate,
      quality: e.quality ?? null,
    },
    conn,
  );
}

export async function softDeleteSleep(db, conn, id) {
  await db.run(
    'UPDATE sleep_entries SET deleted_at = NOW(3) WHERE id = :id',
    { id: toBin(id) },
    conn,
  );
}

/** Bir günün (uyanış günü) uyku kayıtları, en son biten önce. */
export async function sleepOfDay(db, userId, date) {
  const rows = await db.many(
    `SELECT ${SLEEP_COLUMNS} FROM sleep_entries
      WHERE user_id = :userId AND local_date = :date AND deleted_at IS NULL
      ORDER BY sleep_end DESC, id DESC`,
    { userId: toBin(userId), date },
  );
  return rows.map(toSleep);
}
