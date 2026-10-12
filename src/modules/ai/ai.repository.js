import { toBin } from '../../shared/ids.js';

/** Atomik artırma; yeni değeri döner (09 §4). */
export async function incrementQuota(db, userId, localDate, kind) {
  const params = { userId: toBin(userId), localDate, kind };
  await db.run(
    `INSERT INTO ai_quota_daily (user_id, local_date, kind, count) VALUES (:userId, :localDate, :kind, 1)
     ON DUPLICATE KEY UPDATE count = count + 1`,
    params,
  );
  const row = await db.one(
    `SELECT count FROM ai_quota_daily
      WHERE user_id = :userId AND local_date = :localDate AND kind = :kind`,
    params,
  );
  return Number(row?.count ?? 0);
}

export async function decrementQuota(db, userId, localDate, kind) {
  await db.run(
    `UPDATE ai_quota_daily SET count = GREATEST(count, 1) - 1
      WHERE user_id = :userId AND local_date = :localDate AND kind = :kind`,
    { userId: toBin(userId), localDate, kind },
  );
}

export async function quotaUsage(db, userId, localDate) {
  const rows = await db.many(
    'SELECT kind, count FROM ai_quota_daily WHERE user_id = :userId AND local_date = :localDate',
    { userId: toBin(userId), localDate },
  );
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.count)]));
}

export async function recordUsage(db, userId, feature, u) {
  await db.run(
    `INSERT INTO ai_usage_daily
       (user_id, usage_date, feature, requests, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, cost_micro_usd)
     VALUES (:userId, UTC_DATE(), :feature, 1, :input, :output, :cacheRead, :cacheWrite, :cost)
     ON DUPLICATE KEY UPDATE requests = requests + 1, input_tokens = input_tokens + VALUES(input_tokens),
       output_tokens = output_tokens + VALUES(output_tokens),
       cache_read_tokens = cache_read_tokens + VALUES(cache_read_tokens),
       cache_write_tokens = cache_write_tokens + VALUES(cache_write_tokens),
       cost_micro_usd = cost_micro_usd + VALUES(cost_micro_usd)`,
    {
      userId: toBin(userId),
      feature,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cost: u.costMicroUsd ?? 0,
    },
  );
}

export async function aiConsentGranted(db, userId) {
  const row = await db.one(
    `SELECT granted FROM user_consents
      WHERE user_id = :userId AND consent_type = 'ai_processing'
      ORDER BY created_at DESC LIMIT 1`,
    { userId: toBin(userId) },
  );
  return Boolean(row?.granted);
}

/** 3 günden eski kota satırları (sayaç yalnızca bugün/dün için anlamlı). */
export async function deleteOldQuota(db) {
  const r = await db.run(
    'DELETE FROM ai_quota_daily WHERE local_date < DATE_SUB(UTC_DATE(), INTERVAL 3 DAY)',
  );
  return r.affectedRows;
}
