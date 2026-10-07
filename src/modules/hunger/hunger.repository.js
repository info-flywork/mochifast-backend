import { fromBin, toBin } from '../../shared/ids.js';
import { isoDate } from '../../shared/time.js';

const COLUMNS = `id, user_id, logged_at, local_date, mode, symptoms, q1_simple_food, q2_onset,
                 q3_body_notices, q4_craving, physical_score, emotional_score, result_type,
                 safety_flag, scoring_version, notes_enc, fasting_session_id, fasted_minutes,
                 deleted_at`;

const set = (v) => (v ? String(v).split(',').filter(Boolean) : []);

function toCheckin(r) {
  return {
    id: fromBin(r.id),
    loggedAt: r.logged_at,
    localDate: isoDate(r.local_date),
    mode: r.mode,
    symptoms: set(r.symptoms),
    q1: r.q1_simple_food ?? null,
    q2: r.q2_onset ?? null,
    bodyNotices: set(r.q3_body_notices),
    q4: r.q4_craving ?? null,
    physicalScore: r.physical_score,
    emotionalScore: r.emotional_score,
    resultType: r.result_type,
    safetyFlag: Boolean(r.safety_flag),
    scoringVersion: r.scoring_version,
    notesEnc: r.notes_enc ?? null,
    fastId: r.fasting_session_id ? fromBin(r.fasting_session_id) : null,
    fastedMinutes: r.fasted_minutes ?? null,
  };
}

export async function findCheckin(db, userId, id, conn, { includeDeleted = false } = {}) {
  const row = await db.one(
    `SELECT ${COLUMNS} FROM hunger_checkins WHERE id = :id`,
    { id: toBin(id) },
    conn,
  );
  if (!row) return null;
  if (fromBin(row.user_id) !== userId) return { foreign: true };
  if (row.deleted_at && !includeDeleted) return null;
  return toCheckin(row);
}

/** Değerler DB enum'larıyla (snake_case) gelir. */
export async function insertCheckin(db, conn, userId, c) {
  await db.run(
    `INSERT INTO hunger_checkins
       (id, user_id, logged_at, local_date, tz, mode, symptoms, q1_simple_food, q2_onset,
        q3_body_notices, q4_craving, physical_score, emotional_score, result_type, safety_flag,
        scoring_version, notes_enc, fasting_session_id, fasted_minutes)
     VALUES (:id, :userId, :loggedAt, :localDate, :tz, :mode, :symptoms, :q1, :q2, :q3, :q4,
             :physical, :emotional, :resultType, :safetyFlag, :scoringVersion, :notesEnc,
             :fastId, :fastedMinutes)`,
    {
      id: toBin(c.id),
      userId: toBin(userId),
      loggedAt: c.loggedAt,
      localDate: c.localDate,
      tz: c.tz,
      mode: c.mode,
      symptoms: c.symptoms.join(','),
      q1: c.q1 ?? null,
      q2: c.q2 ?? null,
      q3: c.bodyNotices.join(','),
      q4: c.q4 ?? null,
      physical: c.physicalScore,
      emotional: c.emotionalScore,
      resultType: c.resultType,
      safetyFlag: c.safetyFlag ? 1 : 0,
      scoringVersion: c.scoringVersion,
      notesEnc: c.notesEnc ?? null,
      fastId: c.fastId ? toBin(c.fastId) : null,
      fastedMinutes: c.fastedMinutes ?? null,
    },
    conn,
  );
}

export async function softDeleteCheckin(db, conn, id) {
  await db.run(
    'UPDATE hunger_checkins SET deleted_at = NOW(3) WHERE id = :id',
    { id: toBin(id) },
    conn,
  );
}

/** Yeniden eskiye; imleç (logged_at, id). */
export async function listCheckins(db, userId, { date, type, before, limit }) {
  const rows = await db.many(
    `SELECT ${COLUMNS} FROM hunger_checkins
      WHERE user_id = :userId AND deleted_at IS NULL
        AND (:date IS NULL OR local_date = :date)
        AND (:type IS NULL OR result_type = :type)
        AND (:beforeAt IS NULL OR logged_at < :beforeAt
             OR (logged_at = :beforeAt AND id < :beforeId))
      ORDER BY logged_at DESC, id DESC
      LIMIT :limit`,
    {
      userId: toBin(userId),
      date: date ?? null,
      type: type ?? null,
      beforeAt: before?.at ?? null,
      beforeId: before ? toBin(before.id) : null,
      limit: String(limit + 1),
    },
  );
  return rows.map(toCheckin);
}
