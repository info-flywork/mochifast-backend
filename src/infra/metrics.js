import { createServer } from 'node:http';
import client from 'prom-client';

/**
 * Prometheus metrikleri. `/metrics` ana API portunda DEĞİL, ayrı ve yalnızca iç ağdan
 * erişilen bir portta sunulur (docs/backend/02-mimari.md §5).
 */

/**
 * @param options.service api | worker | scheduler
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
