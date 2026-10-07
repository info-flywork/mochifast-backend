import { createServer } from 'node:http';
import client from 'prom-client';

/**
 * Prometheus metrikleri. `/metrics` ana API portunda DEĞİL, ayrı ve yalnızca iç ağdan
 * erişilen bir portta sunulur (docs/backend/02-mimari.md §5).
 */

/**
 * @param options.service api | worker
 */
export function createMetrics({ service, dbPoolStats }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });

  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP istek süresi',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const cacheRequests = new client.Counter({
    name: 'cache_requests_total',
    help: 'Cache okuma sonuçları',
    labelNames: ['result'],
    registers: [registry],
  });

  if (dbPoolStats) {
    new client.Gauge({
      name: 'db_pool_connections',
      help: 'mysql2 havuz bağlantıları',
      labelNames: ['state'],
      registers: [registry],
      collect() {
        const s = dbPoolStats();
        this.set({ state: 'total' }, s.total);
        this.set({ state: 'free' }, s.free);
        this.set({ state: 'queued' }, s.queued);
      },
    });
  }

  return {
    registry,
    httpDuration,
    cache: { record: (result) => cacheRequests.inc({ result }) },
  };
}

/**
 * Worker metrikleri (F11): iş sonuç/süre sayaçları + DB'den okunan operasyon göstergeleri
 * (kuyruk birikimi, AI maliyeti, push teslimi, geciken bildirimler). DB göstergeleri her
 * scrape'te okunur (küçük, indeksli sorgular).
 */
export function createWorkerMetrics({ db, dbPoolStats }) {
  const metrics = createMetrics({ service: 'worker', dbPoolStats });
  const { registry } = metrics;

  const jobRuns = new client.Counter({
    name: 'jobs_runs_total',
    help: 'Çalışan işler (done | retry | failed)',
    labelNames: ['queue', 'job', 'outcome'],
    registers: [registry],
  });
  const jobDuration = new client.Histogram({
    name: 'jobs_duration_seconds',
    help: 'İş süresi',
    labelNames: ['queue', 'job'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
    registers: [registry],
  });

  const gauge = (name, help, labelNames, collect) =>
    new client.Gauge({ name, help, labelNames, registers: [registry], collect });

  gauge('jobs_count', 'jobs tablosu: kuyruk × durum', ['queue', 'status'], async function () {
    this.reset();
    const rows = await db.many(
      "SELECT queue, status, COUNT(*) AS n FROM jobs WHERE status IN ('pending', 'running', 'failed') GROUP BY queue, status",
    );
    for (const r of rows) this.set({ queue: r.queue, status: r.status }, Number(r.n));
  });
  gauge(
    'jobs_oldest_pending_seconds',
    'Vadesi gelmiş en eski bekleyen işin yaşı (birikim)',
    ['queue'],
    async function () {
      this.reset();
      const rows = await db.many(
        `SELECT queue, TIMESTAMPDIFF(SECOND, MIN(run_at), NOW(3)) AS age FROM jobs
          WHERE status = 'pending' AND run_at <= NOW(3) GROUP BY queue`,
      );
      for (const r of rows) this.set({ queue: r.queue }, Number(r.age ?? 0));
    },
  );
  gauge('ai_cost_today_usd', 'Bugünkü (UTC) AI maliyeti', [], async function () {
    const row = await db.one(
      'SELECT COALESCE(SUM(cost_micro_usd), 0) AS c FROM ai_usage_daily WHERE usage_date = UTC_DATE()',
    );
    this.set(Number(row.c) / 1e6);
  });
  gauge('push_deliveries_last_hour', 'Son 1 saatte push teslimi', ['status'], async function () {
    this.reset();
    const rows = await db.many(
      `SELECT status, COUNT(*) AS n FROM push_deliveries
        WHERE created_at >= DATE_SUB(NOW(3), INTERVAL 1 HOUR) GROUP BY status`,
    );
    for (const r of rows) this.set({ status: r.status }, Number(r.n));
  });
  gauge(
    'notifications_overdue',
    'Vadesi 5 dakikadan fazla geçmiş planlı bildirim (dağıtıcı takılması)',
    [],
    async function () {
      const row = await db.one(
        `SELECT COUNT(*) AS n FROM scheduled_notifications
          WHERE status = 'scheduled' AND fire_at < DATE_SUB(NOW(3), INTERVAL 5 MINUTE)`,
      );
      this.set(Number(row.n));
    },
  );

  return {
    ...metrics,
    jobFinished(queue, job, outcome, ms) {
      jobRuns.inc({ queue, job, outcome });
      jobDuration.observe({ queue, job }, ms / 1000);
    },
  };
}

/**
 * İç metrik sunucusu.
 */
export function startMetricsServer(metrics, { host, port }) {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      res.setHeader('Content-Type', metrics.registry.contentType);
      res.end(await metrics.registry.metrics());
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
