import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createWorkerMetrics } from '../../src/infra/metrics.js';
import { createJobQueue, createWorker } from '../../src/infra/queue.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');

describe.skipIf(!mysqlUrl)('worker metrikleri (gerçek MySQL)', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('iş sonuçları ve DB göstergeleri Prometheus çıktısında', async () => {
    const metrics = createWorkerMetrics({ db: ctx.db });
    const jobs = createJobQueue(ctx.db);
    await jobs.enqueue('mtest', 'ok', {});
    await jobs.enqueue('mtest', 'boom', {}, { maxAttempts: 1 });
    await jobs.enqueue('mtest-idle', 'later', {});
    const worker = createWorker({
      db: ctx.db,
      queue: 'mtest',
      handlers: {
        ok: async () => {},
        boom: async () => {
          throw new Error('x');
        },
      },
      pollMs: 20,
      metrics,
    });
    for (let i = 0; i < 50; i += 1) {
      const row = await ctx.db.one(
        "SELECT COUNT(*) AS n FROM jobs WHERE queue = 'mtest' AND status IN ('pending', 'running')",
      );
      if (Number(row.n) === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await worker.close();

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /jobs_runs_total\{queue="mtest",job="ok",outcome="done",service="worker"\} 1/,
    );
    expect(text).toMatch(
      /jobs_runs_total\{queue="mtest",job="boom",outcome="failed",service="worker"\} 1/,
    );
    expect(text).toMatch(/jobs_count\{queue="mtest",status="failed",service="worker"\} 1/);
    expect(text).toMatch(/jobs_oldest_pending_seconds\{queue="mtest-idle",service="worker"\} \d+/);
    expect(text).toMatch(/ai_cost_today_usd\{service="worker"\} 0/);
    expect(text).toMatch(/notifications_overdue\{service="worker"\} 0/);
  });
});
