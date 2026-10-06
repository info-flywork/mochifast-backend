import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * MySQL tabanlı iş kuyruğu (docs/adr/0005-redis-yok.md).
 *
 * - API yalnızca `jobs` tablosuna satır EKLER; işleri `worker` process'i tüketir.
 * - Kuyruğa atma bir iş işlemiyle aynı transaction'da yapılabilir (`conn`): "kayıt yazıldı ama
 *   iş kayboldu" ya da "iş atıldı ama kayıt geri alındı" durumu oluşmaz.
 * - Worker'lar `FOR UPDATE SKIP LOCKED` ile iş kapar: birden çok worker aynı işi almaz.
 * - Çöken worker'ın işi `locked_until` dolunca tekrar kuyruğa döner (en az bir kez çalıştırma:
 *   handler'lar idempotent yazılmalı).
 */

export const JOB_DEFAULTS = Object.freeze({
  maxAttempts: 5,
  timeoutMs: 5 * 60_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 10 * 60_000,
});

const ER_DUP_ENTRY = 1062;

/** Üstel geri çekilme + %20'ye kadar rastgele sapma. `attempt` 1'den başlar. */
export function backoffMs(attempt, random = Math.random) {
  const base = Math.min(JOB_DEFAULTS.backoffBaseMs * 2 ** (attempt - 1), JOB_DEFAULTS.backoffMaxMs);
  return Math.round(base * (1 + 0.2 * random()));
}

/**
 * Kuyruğa iş atan istemci (API ve worker kullanır).
 */
export function createJobQueue(db) {
  return {
    /**
     * @param options.delayMs işin en erken çalışacağı zaman (şimdiden itibaren)
     * @param options.dedupeKey aynı kuyrukta aynı anahtarla ikinci iş eklenmez (satır silinene dek)
     * @param options.conn açık transaction bağlantısı (iş kaydıyla atomik ekleme için)
     * @returns `{ id, deduped }` — deduped=true ise iş zaten vardı, yenisi eklenmedi
     */
    async enqueue(queue, name, payload = {}, options = {}) {
      const {
        delayMs = 0,
        maxAttempts = JOB_DEFAULTS.maxAttempts,
        dedupeKey = null,
        conn,
      } = options;
      try {
        const result = await db.run(
          `INSERT INTO jobs (queue, name, payload, max_attempts, run_at, dedupe_key)
           VALUES (:queue, :name, :payload, :maxAttempts,
                   DATE_ADD(NOW(3), INTERVAL :delayUs MICROSECOND), :dedupeKey)`,
          {
            queue,
            name,
            payload: JSON.stringify(payload),
            maxAttempts,
            delayUs: Math.max(0, Math.round(delayMs)) * 1000,
            dedupeKey,
          },
          conn,
        );
        return { id: Number(result.insertId), deduped: false };
      } catch (err) {
        // Yinelenen anahtar yalnızca o ifadeyi geri alır; açık transaction bozulmaz.
        if (err?.errno !== ER_DUP_ENTRY || dedupeKey === null) throw err;
        const existing = await db.one(
          'SELECT id FROM jobs WHERE queue = :queue AND dedupe_key = :dedupeKey',
          { queue, dedupeKey },
          conn,
        );
        return { id: Number(existing?.id ?? 0), deduped: true };
      }
    },
  };
}

/**
 * Bir kuyruğun işlerini tüketen worker. İş adına göre handler seçer.
 * Handler imzası: `async ({ id, name, payload, attempt, maxAttempts }) => void`.
 */
export function createWorker({
  db,
  queue,
  handlers,
  concurrency = 5,
  pollMs = 1_000,
  timeoutMs = JOB_DEFAULTS.timeoutMs,
  reapEveryMs = 30_000,
  logger,
  workerId = `${hostname()}:${process.pid}`,
}) {
  const active = new Set();
  const stopper = new AbortController();
  let lastReap = 0;
  const logError = throttledLogger(logger, 'kuyruk hatası');
  // Kilit süresi iş zaman aşımından uzun olmalı; yoksa hâlâ çalışan iş tekrar kuyruğa döner.
  const lockSec = Math.ceil(timeoutMs / 1000) + 60;

  async function claim(limit) {
    return db.withTransaction(async (conn) => {
      const rows = await db.many(
        `SELECT id, name, payload, attempts, max_attempts
           FROM jobs
          WHERE queue = :queue AND status = 'pending' AND run_at <= NOW(3)
          ORDER BY run_at, id
          LIMIT :limit
          FOR UPDATE SKIP LOCKED`,
        // mysql2 prepared statement'ta LIMIT parametresi string olmalı.
        { queue, limit: String(limit) },
        conn,
      );
      for (const row of rows) {
        await db.run(
          `UPDATE jobs
              SET status = 'running', attempts = attempts + 1, locked_by = :workerId,
                  locked_until = DATE_ADD(NOW(3), INTERVAL :lockSec SECOND)
            WHERE id = :id`,
          { id: row.id, workerId, lockSec },
          conn,
        );
      }
      return rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        // MySQL JSON kolonu nesne döner; MariaDB'de JSON = LONGTEXT olduğu için string gelir.
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        attempt: row.attempts + 1,
        maxAttempts: row.max_attempts,
      }));
    });
  }

  /** Kilidi dolmuş (worker çökmüş) işleri tekrar kuyruğa alır; deneme hakkı bittiyse başarısız sayar. */
  async function reap() {
    const failed = await db.run(
      `UPDATE jobs
          SET status = 'failed', finished_at = NOW(3), locked_by = NULL, locked_until = NULL,
              last_error = 'kilit süresi doldu (worker yanıt vermedi)'
        WHERE status = 'running' AND locked_until < NOW(3) AND queue = :queue
          AND attempts >= max_attempts`,
      { queue },
    );
    const requeued = await db.run(
      `UPDATE jobs
          SET status = 'pending', locked_by = NULL, locked_until = NULL
        WHERE status = 'running' AND locked_until < NOW(3) AND queue = :queue`,
      { queue },
    );
    if (failed.affectedRows || requeued.affectedRows) {
      logger?.warn(
        { queue, requeued: requeued.affectedRows, failed: failed.affectedRows },
        'kilidi dolan işler toplandı',
      );
    }
  }

  async function execute(job) {
    const handler = handlers[job.name];
    const started = performance.now();
    try {
      if (!handler) throw new Error(`"${queue}" kuyruğunda bilinmeyen iş: ${job.name}`);
      await withTimeout(handler(job), timeoutMs);
      await db.run(
        `UPDATE jobs
            SET status = 'done', finished_at = NOW(3), locked_by = NULL, locked_until = NULL,
                last_error = NULL
          WHERE id = :id AND locked_by = :workerId`,
        { id: job.id, workerId },
      );
      logger?.debug(
        { queue, job: job.name, jobId: job.id, ms: Math.round(performance.now() - started) },
        'iş tamamlandı',
      );
    } catch (err) {
      const final = !handler || job.attempt >= job.maxAttempts;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
      const sql = final
        ? `UPDATE jobs
              SET status = 'failed', finished_at = NOW(3), locked_by = NULL, locked_until = NULL,
                  last_error = :message
            WHERE id = :id AND locked_by = :workerId`
        : `UPDATE jobs
              SET status = 'pending', locked_by = NULL, locked_until = NULL, last_error = :message,
                  run_at = DATE_ADD(NOW(3), INTERVAL :delayUs MICROSECOND)
            WHERE id = :id AND locked_by = :workerId`;
      await db
        .run(sql, { id: job.id, workerId, message, delayUs: backoffMs(job.attempt) * 1000 })
        .catch(logError);
      logger?.error(
        { queue, job: job.name, jobId: job.id, attempt: job.attempt, final, err },
        final ? 'iş başarısız (son deneme)' : 'iş başarısız; tekrar denenecek',
      );
    }
  }

  async function loop() {
    while (!stopper.signal.aborted) {
      try {
        if (Date.now() - lastReap >= reapEveryMs) {
          lastReap = Date.now();
          await reap();
        }
        const free = concurrency - active.size;
        const jobs = free > 0 ? await claim(free) : [];
        for (const job of jobs) {
          const run = execute(job).finally(() => active.delete(run));
          active.add(run);
        }
        // Tüm yuvalar doluysa birinin bitmesini bekle; iş geldiyse hemen tekrar bak.
        if (active.size >= concurrency) {
          await Promise.race(active);
          continue;
        }
        if (jobs.length > 0) continue;
      } catch (err) {
        logError(err);
      }
      await sleep(pollMs, undefined, { signal: stopper.signal }).catch(() => {});
    }
  }

  const running = loop();

  return {
    name: queue,
    /** Yeni iş almayı bırakır, çalışan işlerin bitmesini bekler. */
    async close() {
      stopper.abort();
      await running;
      await Promise.allSettled([...active]);
    },
  };
}

/**
 * Tekrarlı işler. Tanımlar koddadır (`src/schedules.js`); `sync` tabloyu onlarla eşitler,
 * `start` her `tickMs`'de vadesi gelenleri kuyruğa atar. Birden çok worker çalışsa da her tekrar
 * bir kez atılır (`SKIP LOCKED` + aynı transaction'da sonraki zamanın ilerletilmesi).
 */
export function createScheduler({ db, schedules, tickMs = 1_000, logger }) {
  const jobs = createJobQueue(db);
  const stopper = new AbortController();
  const logError = throttledLogger(logger, 'zamanlayıcı hatası');
  let running = null;

  async function sync() {
    for (const s of schedules) {
      // Aralık değişmediyse sıradaki çalışma zamanı korunur; değiştiyse hemen çalışır.
      // ON DUPLICATE KEY atamaları soldan sağa uygulanır: next_run_at, every_ms'ten ÖNCE gelmeli.
      await db.run(
        `INSERT INTO job_schedules (id, queue, name, every_ms, next_run_at)
         VALUES (:id, :queue, :name, :everyMs, NOW(3))
         ON DUPLICATE KEY UPDATE
           next_run_at = IF(every_ms = VALUES(every_ms), next_run_at, VALUES(next_run_at)),
           queue = VALUES(queue), name = VALUES(name), every_ms = VALUES(every_ms)`,
        { id: s.id, queue: s.queue, name: s.jobName, everyMs: s.everyMs },
      );
    }
    const wanted = new Set(schedules.map((s) => s.id));
    const existing = await db.many('SELECT id FROM job_schedules');
    let removed = 0;
    for (const { id } of existing) {
      if (!wanted.has(id)) {
        await db.run('DELETE FROM job_schedules WHERE id = :id', { id });
        removed += 1;
      }
    }
    return { upserted: schedules.length, removed };
  }

  async function tick() {
    return db.withTransaction(async (conn) => {
      const due = await db.many(
        `SELECT id, queue, name, every_ms
           FROM job_schedules
          WHERE next_run_at <= NOW(3)
          FOR UPDATE SKIP LOCKED`,
        {},
        conn,
      );
      for (const s of due) {
        await jobs.enqueue(s.queue, s.name, { scheduleId: s.id }, { conn, maxAttempts: 1 });
        // Sonraki çalışma şimdiden hesaplanır: kesinti sonrası birikmiş tekrarlar art arda patlamaz.
        await db.run(
          `UPDATE job_schedules
              SET next_run_at = DATE_ADD(NOW(3), INTERVAL :everyUs MICROSECOND)
            WHERE id = :id`,
          { id: s.id, everyUs: s.every_ms * 1000 },
          conn,
        );
      }
      return due.length;
    });
  }

  async function loop() {
    while (!stopper.signal.aborted) {
      await tick().catch(logError);
      await sleep(tickMs, undefined, { signal: stopper.signal }).catch(() => {});
    }
  }

  return {
    sync,
    tick,
    start() {
      running ??= loop();
    },
    async close() {
      stopper.abort();
      await running;
    },
  };
}

async function withTimeout(promise, ms) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      sleep(ms, undefined, { signal: controller.signal }).then(() => {
        throw new Error(`iş zaman aşımı (${ms} ms)`);
      }),
    ]);
  } finally {
    controller.abort();
  }
}

/** DB kesintisinde her döngüde hata basmamak için 10 sn'de bir loglar. */
function throttledLogger(logger, message) {
  let last = 0;
  let suppressed = 0;
  return (err) => {
    const now = Date.now();
    if (now - last < 10_000) {
      suppressed += 1;
      return;
    }
    logger?.error({ err, suppressed }, message);
    last = now;
    suppressed = 0;
  };
}
