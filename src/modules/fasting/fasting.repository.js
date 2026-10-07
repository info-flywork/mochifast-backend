import { fromBin, newId, toBin } from '../../shared/ids.js';

/** Sayılan (iptal edilmemiş, silinmemiş) seanslar. */
const LIVE = "s.deleted_at IS NULL AND s.status <> 'cancelled'";

const COLUMNS = `s.id, s.user_plan_id, s.plan_code, s.target_minutes, s.status, s.started_at,
  s.planned_end_at, s.ended_at, s.duration_minutes, s.goal_reached, s.end_local_date,
  s.start_local_date, s.tz, s.feeling, s.notes_enc, s.weight_entry_id, s.source, s.auto_closed,
  s.created_at`;

export function toSession(r) {
  return (
    r && {
      id: fromBin(r.id),
      userPlanId: r.user_plan_id ? fromBin(r.user_plan_id) : null,
      planCode: r.plan_code,
      targetMinutes: r.target_minutes,
      status: r.status,
      startedAt: r.started_at,
      plannedEndAt: r.planned_end_at,
      endedAt: r.ended_at ?? null,
      durationMinutes: r.duration_minutes ?? null,
      goalReached: Boolean(r.goal_reached),
      endLocalDate: r.end_local_date ? isoDate(r.end_local_date) : null,
      startLocalDate: isoDate(r.start_local_date),
      tz: r.tz,
      feeling: r.feeling ?? null,
      notesEnc: r.notes_enc ?? null,
      weightEntryId: r.weight_entry_id ? fromBin(r.weight_entry_id) : null,
      source: r.source,
      autoClosed: Boolean(r.auto_closed),
      createdAt: r.created_at,
    }
  );
}

export async function insert(db, conn, s) {
  await db.run(
    `INSERT INTO fasting_sessions
       (id, user_id, user_plan_id, plan_code, target_minutes, status, started_at, planned_end_at,
        ended_at, duration_minutes, goal_reached, end_local_date, start_local_date, tz, feeling,
        notes_enc, weight_entry_id, source)
     VALUES (:id, :userId, :userPlanId, :planCode, :targetMinutes, :status, :startedAt, :plannedEndAt,
             :endedAt, :durationMinutes, :goalReached, :endLocalDate, :startLocalDate, :tz, :feeling,
             :notesEnc, :weightEntryId, :source)`,
    {
      id: toBin(s.id),
      userId: toBin(s.userId),
      userPlanId: s.userPlanId ? toBin(s.userPlanId) : null,
      planCode: s.planCode ?? null,
      targetMinutes: s.targetMinutes,
      status: s.status,
      startedAt: s.startedAt,
      plannedEndAt: s.plannedEndAt,
      endedAt: s.endedAt ?? null,
      durationMinutes: s.durationMinutes ?? null,
      goalReached: s.goalReached ? 1 : 0,
      endLocalDate: s.endLocalDate ?? null,
      startLocalDate: s.startLocalDate,
      tz: s.tz,
      feeling: s.feeling ?? null,
      notesEnc: s.notesEnc ?? null,
      weightEntryId: s.weightEntryId ? toBin(s.weightEntryId) : null,
      source: s.source ?? 'app',
    },
    conn,
  );
}

/** Kimliğe göre seans (silinmiş dahil değil); `forUpdate` ile kilitlenir. */
export async function findById(
  db,
  userId,
  id,
  conn,
  { forUpdate = false, includeDeleted = false } = {},
) {
  const row = await db.one(
    `SELECT ${COLUMNS}, s.user_id, s.deleted_at FROM fasting_sessions s
      WHERE s.id = :id ${includeDeleted ? '' : 'AND s.deleted_at IS NULL'}
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    { id: toBin(id) },
    conn,
  );
  if (!row) return null;
  // Başka kullanıcının kaydı yok sayılır (varlığı sızdırılmaz → 404).
  if (fromBin(row.user_id) !== userId) return { foreign: true };
  return toSession(row);
}

export async function findActive(db, userId, conn, { forUpdate = false } = {}) {
  const row = await db.one(
    `SELECT ${COLUMNS} FROM fasting_sessions s
      WHERE s.user_id = :userId AND s.status = 'active' AND s.deleted_at IS NULL
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    { userId: toBin(userId) },
    conn,
  );
  return toSession(row);
}

/**
 * [start, end) aralığına dokunan sayılan seanslar; satırlar kilitlenir (çakışma kontrolü,
 * 03 §3.4). Aktif seansın bitişi planlanan bitiştir.
 */
export async function findOverlapping(db, conn, userId, start, end, excludeId) {
  const rows = await db.many(
    `SELECT ${COLUMNS} FROM fasting_sessions s
      WHERE s.user_id = :userId AND ${LIVE}
        AND s.started_at < :end AND COALESCE(s.ended_at, s.planned_end_at) > :start
        AND (:excludeId IS NULL OR s.id <> :excludeId)
      FOR UPDATE`,
    { userId: toBin(userId), start, end, excludeId: excludeId ? toBin(excludeId) : null },
    conn,
  );
  return rows.map(toSession);
}

const UPDATABLE = {
  targetMinutes: 'target_minutes',
  status: 'status',
  startedAt: 'started_at',
  plannedEndAt: 'planned_end_at',
  endedAt: 'ended_at',
  durationMinutes: 'duration_minutes',
  goalReached: 'goal_reached',
  endLocalDate: 'end_local_date',
  startLocalDate: 'start_local_date',
  feeling: 'feeling',
  notesEnc: 'notes_enc',
  weightEntryId: 'weight_entry_id',
  autoClosed: 'auto_closed',
};

export async function update(db, conn, id, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE[k]);
  if (keys.length === 0) return;
  const params = { id: toBin(id) };
  for (const k of keys) {
    let v = fields[k];
    if (k === 'goalReached' || k === 'autoClosed') v = v ? 1 : 0;
    if (k === 'weightEntryId' && v) v = toBin(v);
    params[k] = v ?? null;
  }
  // Kolon adları yalnızca UPDATABLE sözlüğünden gelir (kullanıcı girdisi değil).
  const sql = `UPDATE fasting_sessions SET ${keys.map((k) => `${UPDATABLE[k]} = :${k}`).join(', ')} WHERE id = :id`;
  await db.run(sql, params, conn);
}

export async function hardDelete(db, conn, id) {
  await db.run('DELETE FROM fasting_sessions WHERE id = :id', { id: toBin(id) }, conn);
}

export async function softDelete(db, conn, id) {
  await db.run(
    'UPDATE fasting_sessions SET deleted_at = NOW(3) WHERE id = :id',
    { id: toBin(id) },
    conn,
  );
}

/** Geçmiş: en yeni başlangıç önce; imleç (started_at, id). */
export async function list(db, userId, { from, to, status, before, limit }) {
  const rows = await db.many(
    `SELECT ${COLUMNS} FROM fasting_sessions s
      WHERE s.user_id = :userId AND s.deleted_at IS NULL
        AND (:status IS NULL OR s.status = :status)
        AND (:from IS NULL OR COALESCE(s.end_local_date, s.start_local_date) >= :from)
        AND (:to IS NULL OR COALESCE(s.end_local_date, s.start_local_date) <= :to)
        AND (:beforeAt IS NULL OR s.started_at < :beforeAt
             OR (s.started_at = :beforeAt AND s.id < :beforeId))
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT :limit`,
    {
      userId: toBin(userId),
      status: status ?? null,
      from: from ?? null,
      to: to ?? null,
      beforeAt: before?.at ?? null,
      beforeId: before ? toBin(before.id) : null,
      limit: String(limit + 1),
    },
  );
  return rows.map(toSession);
}

/** Yeme penceresi için son biten (tamamlanan/erken biten) seans. */
export async function lastFinished(db, userId) {
  const row = await db.one(
    `SELECT ${COLUMNS} FROM fasting_sessions s
      WHERE s.user_id = :userId AND s.deleted_at IS NULL
        AND s.status IN ('completed', 'ended_early')
      ORDER BY s.ended_at DESC LIMIT 1`,
    { userId: toBin(userId) },
  );
  return toSession(row);
}

export async function insertStruggle(db, userId, e) {
  const id = newId();
  await db.run(
    `INSERT INTO struggle_events
       (id, user_id, fasting_session_id, reason, tip, tip_completed, outcome, elapsed_minutes)
     VALUES (:id, :userId, :sessionId, :reason, :tip, :tipCompleted, :outcome, :elapsedMinutes)`,
    {
      id: toBin(id),
      userId: toBin(userId),
      sessionId: e.sessionId ? toBin(e.sessionId) : null,
      reason: e.reason,
      tip: e.tip ?? null,
      tipCompleted: e.tipCompleted ? 1 : 0,
      outcome: e.outcome ?? null,
      elapsedMinutes: e.elapsedMinutes ?? null,
    },
  );
  return id;
}

function isoDate(v) {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}
