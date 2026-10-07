import { fromBin, toBin } from '../../shared/ids.js';
import { isoDate } from '../../shared/time.js';

const COLUMNS = `id, user_id, media_id, status, locale, quota_date, model, prompt_version,
                 CAST(result AS CHAR) AS result, error_code, input_tokens, output_tokens,
                 latency_ms, created_at, completed_at`;

function toAnalysis(r) {
  return (
    r && {
      id: fromBin(r.id),
      userId: fromBin(r.user_id),
      mediaId: fromBin(r.media_id),
      status: r.status,
      locale: r.locale,
      quotaDate: isoDate(r.quota_date),
      model: r.model ?? null,
      promptVersion: r.prompt_version ?? null,
      result: r.result ? JSON.parse(r.result) : null,
      errorCode: r.error_code ?? null,
      inputTokens: r.input_tokens ?? null,
      outputTokens: r.output_tokens ?? null,
      latencyMs: r.latency_ms ?? null,
      createdAt: r.created_at,
      completedAt: r.completed_at ?? null,
    }
  );
}

export async function findAnalysis(db, id, conn) {
  return toAnalysis(
    await db.one(
      `SELECT ${COLUMNS} FROM food_photo_analyses WHERE id = :id`,
      { id: toBin(id) },
      conn,
    ),
  );
}

/** Aynı fotoğrafın (yinelenen yükleme) bu kullanıcıdaki en son, başarısız olmamış analizi. */
export async function findByMedia(db, userId, mediaId) {
  return toAnalysis(
    await db.one(
      `SELECT ${COLUMNS} FROM food_photo_analyses
        WHERE user_id = :userId AND media_id = :mediaId AND status <> 'failed'
        ORDER BY created_at DESC LIMIT 1`,
      { userId: toBin(userId), mediaId: toBin(mediaId) },
    ),
  );
}

export async function insertAnalysis(db, a, conn) {
  await db.run(
    `INSERT INTO food_photo_analyses (id, user_id, media_id, status, locale, quota_date)
     VALUES (:id, :userId, :mediaId, 'queued', :locale, :quotaDate)`,
    {
      id: toBin(a.id),
      userId: toBin(a.userId),
      mediaId: toBin(a.mediaId),
      locale: a.locale,
      quotaDate: a.quotaDate,
    },
    conn,
  );
}

/** Yalnızca bekleyen/işlenen kayıt `processing` olur (aynı iş iki kez çalışsa da). */
export async function markProcessing(db, id) {
  const r = await db.run(
    `UPDATE food_photo_analyses SET status = 'processing'
      WHERE id = :id AND status IN ('queued', 'processing')`,
    { id: toBin(id) },
  );
  return r.affectedRows === 1;
}

export async function complete(db, id, f) {
  await db.run(
    `UPDATE food_photo_analyses
        SET status = :status, result = :result, error_code = :errorCode, model = :model,
            prompt_version = :promptVersion, input_tokens = :inputTokens,
            output_tokens = :outputTokens, latency_ms = :latencyMs, completed_at = NOW(3)
      WHERE id = :id`,
    {
      id: toBin(id),
      status: f.status,
      result: f.result ? JSON.stringify(f.result) : null,
      errorCode: f.errorCode ?? null,
      model: f.model ?? null,
      promptVersion: f.promptVersion ?? null,
      inputTokens: f.inputTokens ?? null,
      outputTokens: f.outputTokens ?? null,
      latencyMs: f.latencyMs ?? null,
    },
  );
}

/** İşlenirken takılan analizler (worker çöktü): kuyruk işi bitmiş ama kayıt açık kalmış. */
export async function stuckAnalyses(db, minutes, limit) {
  return (
    await db.many(
      `SELECT ${COLUMNS} FROM food_photo_analyses
        WHERE status IN ('queued', 'processing')
          AND created_at < DATE_SUB(NOW(3), INTERVAL :minutes MINUTE)
        LIMIT :limit`,
      { minutes, limit: String(limit) },
    )
  ).map(toAnalysis);
}
