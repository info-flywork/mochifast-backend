import { fromBin, newId, toBin } from '../../shared/ids.js';

const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

function toUserPlan(r) {
  return {
    id: fromBin(r.id),
    planCode: r.plan_code,
    timing: r.timing,
    fastMinutes: r.fast_minutes,
    eatWindow:
      r.eat_window_start && r.eat_window_end
        ? { start: hhmm(r.eat_window_start), end: hhmm(r.eat_window_end) }
        : null,
    weeklySchedule: r.weekly_schedule ? JSON.parse(r.weekly_schedule) : null,
    safetyAckAt: r.safety_ack_at ?? null,
    startedOn: r.started_on,
    endedAt: r.ended_at ?? null,
  };
}

const SELECT = `SELECT up.id, p.code AS plan_code, up.timing, up.fast_minutes, up.eat_window_start,
                       up.eat_window_end, CAST(up.weekly_schedule AS CHAR) AS weekly_schedule,
                       up.safety_ack_at, up.started_on, up.ended_at, up.created_at
                  FROM user_plans up
                  JOIN fasting_plans p ON p.id = up.plan_id`;

export async function findCurrent(db, userId, conn) {
  const row = await db.one(
    `${SELECT} WHERE up.user_id = :userId AND up.ended_at IS NULL`,
    { userId: toBin(userId) },
    conn,
  );
  return row ? toUserPlan(row) : null;
}

export async function listHistory(db, userId, { limit, before }) {
  const rows = await db.many(
    `${SELECT}
      WHERE up.user_id = :userId AND (:before IS NULL OR up.created_at < :before)
      ORDER BY up.created_at DESC
      LIMIT :limit`,
    { userId: toBin(userId), before: before ?? null, limit: String(limit + 1) },
  );
  return rows;
}

export async function endCurrent(db, conn, userId) {
  await db.run(
    'UPDATE user_plans SET ended_at = NOW(3) WHERE user_id = :userId AND ended_at IS NULL',
    { userId: toBin(userId) },
    conn,
  );
}

export async function insertPlan(db, conn, userId, plan) {
  const id = newId();
  await db.run(
    `INSERT INTO user_plans
       (id, user_id, plan_id, timing, fast_minutes, eat_window_start, eat_window_end,
        weekly_schedule, safety_ack_at, started_on)
     VALUES (:id, :userId, (SELECT id FROM fasting_plans WHERE code = :code), :timing, :fastMinutes,
             :eatStart, :eatEnd, :weeklySchedule, :safetyAckAt, :startedOn)`,
    {
      id: toBin(id),
      userId: toBin(userId),
      code: plan.planCode,
      timing: plan.timing ?? null,
      fastMinutes: plan.fastMinutes,
      eatStart: plan.eatWindow?.start ?? null,
      eatEnd: plan.eatWindow?.end ?? null,
      weeklySchedule: plan.weeklySchedule ? JSON.stringify(plan.weeklySchedule) : null,
      safetyAckAt: plan.safetyAckAt ?? null,
      startedOn: plan.startedOn,
    },
    conn,
  );
  return id;
}

export async function upsertCheckin(db, userId, { localDate, dayType, status }) {
  await db.run(
    `INSERT INTO plan_day_checkins (user_id, local_date, day_type, status)
     VALUES (:userId, :localDate, :dayType, :status)
     ON DUPLICATE KEY UPDATE day_type = VALUES(day_type), status = VALUES(status), auto_suggested = 0`,
    { userId: toBin(userId), localDate, dayType, status },
  );
}

export { toUserPlan };
