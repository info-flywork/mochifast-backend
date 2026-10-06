import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase } from '../../src/infra/db.js';
import { migrate } from '../../src/infra/migrator.js';
import { backoffMs, createJobQueue, createScheduler, createWorker } from '../../src/infra/queue.js';
import { systemJobs } from '../../src/jobs/system.jobs.js';
import { createTestDatabase, testConfig } from '../helpers/infra.js';

const mysqlUrl = inject('mysqlUrl');
const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Koşul sağlanana kadar bekler (worker döngüsü asenkron). */
async function waitFor(fn, timeoutMs = 3_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error('waitFor zaman aşımı');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('backoffMs', () => {
  it('üstel artar, üst sınırı aşmaz', () => {
    expect(backoffMs(1, () => 0)).toBe(2_000);
    expect(backoffMs(3, () => 0)).toBe(8_000);
    expect(backoffMs(2, () => 1)).toBe(4_800);
    expect(backoffMs(30, () => 0)).toBe(600_000);
  });
});

describe.skipIf(!mysqlUrl)('MySQL iş kuyruğu (gerçek MySQL)', () => {
  let testDb;
  let db;
  let jobs;
  const closers = [];

  const job = (id) =>
    db.one(
      'SELECT status, attempts, last_error, locked_by, run_at > NOW(3) AS is_delayed FROM jobs WHERE id = :id',
      { id },
    );

  beforeAll(async () => {
    testDb = await createTestDatabase(mysqlUrl);
    const config = testConfig(testDb.env);
    await migrate({ dbConfig: config.db, dir: migrationsDir, logger: silent });
    db = createDatabase(config.db);
    jobs = createJobQueue(db);
  });

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c.close()));
    await db.run('DELETE FROM jobs');
    await db.run('DELETE FROM job_schedules');
  });

  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  function startWorker(handlers, opts = {}) {
    const w = createWorker({ db, queue: 'test', handlers, pollMs: 20, logger: silent, ...opts });
    closers.push(w);
    return w;
  }

  it('enqueue → worker işler → done; payload JSON olarak gelir', async () => {
    const seen = [];
    const { id } = await jobs.enqueue('test', 'echo', { userId: 'u1', n: 2 });
    startWorker({ echo: async (j) => seen.push(j) });
    await waitFor(async () => (await job(id)).status === 'done');
    expect(seen).toEqual([
      expect.objectContaining({ id, name: 'echo', payload: { userId: 'u1', n: 2 }, attempt: 1 }),
    ]);
    expect((await job(id)).locked_by).toBeNull();
  });

  it('dedupeKey: aynı anahtarla ikinci iş eklenmez', async () => {
    const a = await jobs.enqueue('test', 'x', {}, { dedupeKey: 'streak:u1:2026-10-06' });
    const b = await jobs.enqueue('test', 'x', {}, { dedupeKey: 'streak:u1:2026-10-06' });
    const other = await jobs.enqueue('other', 'x', {}, { dedupeKey: 'streak:u1:2026-10-06' });
    expect(b).toEqual({ id: a.id, deduped: true });
    expect(other.deduped).toBe(false);
  });

  it('transaction geri alınırsa iş de kuyruğa girmez', async () => {
    await expect(
      db.withTransaction(async (conn) => {
        await jobs.enqueue('test', 'x', {}, { conn });
        throw new Error('iş kuralı hatası');
      }),
    ).rejects.toThrow();
    expect(await db.one('SELECT COUNT(*) AS n FROM jobs')).toEqual({ n: 0 });
  });

  it('delayMs dolmadan iş alınmaz', async () => {
    const { id } = await jobs.enqueue('test', 'echo', {}, { delayMs: 60_000 });
    let ran = false;
    startWorker({ echo: async () => (ran = true) });
    await new Promise((r) => setTimeout(r, 150));
    expect(ran).toBe(false);
    expect((await job(id)).status).toBe('pending');
  });

  it('hata → geri çekilmeyle tekrar; deneme hakkı bitince failed', async () => {
    const { id } = await jobs.enqueue('test', 'boom', {}, { maxAttempts: 2 });
    startWorker({
      boom: async () => {
        throw new Error('patladı');
      },
    });
    await waitFor(
      async () => (await job(id)).attempts === 1 && (await job(id)).status === 'pending',
    );
    expect(await job(id)).toMatchObject({ last_error: 'patladı', is_delayed: 1 });

    // Geri çekilmeyi beklemeden son denemeyi tetikle.
    await db.run('UPDATE jobs SET run_at = NOW(3) WHERE id = :id', { id });
    await waitFor(async () => (await job(id)).status === 'failed');
    expect(await job(id)).toMatchObject({ attempts: 2, last_error: 'patladı' });
  });

  it('bilinmeyen iş adı tekrar denenmeden failed olur', async () => {
    const { id } = await jobs.enqueue('test', 'yok', {});
    startWorker({});
    await waitFor(async () => (await job(id)).status === 'failed');
    expect((await job(id)).attempts).toBe(1);
  });

  it('kilidi dolan (çökmüş worker) iş tekrar kuyruğa döner', async () => {
    const { id } = await jobs.enqueue('test', 'echo', {});
    await db.run(
      `UPDATE jobs SET status = 'running', attempts = 1, locked_by = 'olu-worker',
              locked_until = NOW(3) - INTERVAL 1 SECOND WHERE id = :id`,
      { id },
    );
    startWorker({ echo: async () => {} });
    await waitFor(async () => (await job(id)).status === 'done');
    expect((await job(id)).attempts).toBe(2);
  });

  it('eşzamanlılık sınırı aşılmaz, iki worker aynı işi almaz', async () => {
    for (let i = 0; i < 12; i += 1) await jobs.enqueue('test', 'slow', { i });
    let running = 0;
    let peak = 0;
    const done = [];
    const slow = async (j) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      done.push(j.payload.i);
      running -= 1;
    };
    startWorker({ slow }, { concurrency: 2, workerId: 'w1' });
    startWorker({ slow }, { concurrency: 2, workerId: 'w2' });
    await waitFor(async () => done.length === 12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(new Set(done).size).toBe(12);
  });

  it('close: çalışan işin bitmesini bekler', async () => {
    const { id } = await jobs.enqueue('test', 'slow', {});
    let started = false;
    const w = createWorker({
      db,
      queue: 'test',
      pollMs: 20,
      logger: silent,
      handlers: {
        slow: async () => {
          started = true;
          await new Promise((r) => setTimeout(r, 200));
        },
      },
    });
    await waitFor(() => started);
    await w.close();
    expect((await job(id)).status).toBe('done');
  });

  it('zamanlayıcı: sync tanımları eşitler, tick vadesi geleni bir kez kuyruğa atar', async () => {
    await db.run(
      `INSERT INTO job_schedules (id, queue, name, every_ms, next_run_at)
       VALUES ('eski', 'test', 'x', 1000, NOW(3))`,
    );
    const scheduler = createScheduler({
      db,
      logger: silent,
      schedules: [{ id: 'hb', queue: 'test', jobName: 'heartbeat', everyMs: 60_000 }],
    });
    expect(await scheduler.sync()).toEqual({ upserted: 1, removed: 1 });

    // İki worker aynı anda tick atsa da tekrar başına tek iş oluşur.
    const counts = await Promise.all([scheduler.tick(), scheduler.tick()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await scheduler.tick()).toBe(0);
    expect(await db.many('SELECT queue, name, payload FROM jobs')).toEqual([
      { queue: 'test', name: 'heartbeat', payload: { scheduleId: 'hb' } },
    ]);

    // Aralık aynı kalırsa sıradaki zaman korunur; değişirse hemen çalışır.
    await scheduler.sync();
    expect(await scheduler.tick()).toBe(0);
    const changed = createScheduler({
      db,
      logger: silent,
      schedules: [{ id: 'hb', queue: 'test', jobName: 'heartbeat', everyMs: 30_000 }],
    });
    await changed.sync();
    expect(await changed.tick()).toBe(1);
  });

  it('jobsCleanup: yalnızca saklama süresi dolan biten işleri siler', async () => {
    await db.run(
      `INSERT INTO jobs (queue, name, payload, status, finished_at) VALUES
         ('test', 'a', '{}', 'done',    NOW(3) - INTERVAL 8 DAY),
         ('test', 'b', '{}', 'done',    NOW(3) - INTERVAL 1 DAY),
         ('test', 'c', '{}', 'failed',  NOW(3) - INTERVAL 8 DAY),
         ('test', 'd', '{}', 'failed',  NOW(3) - INTERVAL 31 DAY),
         ('test', 'e', '{}', 'pending', NULL)`,
    );
    await systemJobs({ db, logger: silent }).jobsCleanup();
    const left = await db.many('SELECT name FROM jobs ORDER BY name');
    expect(left.map((r) => r.name)).toEqual(['b', 'c', 'e']);
  });
});
