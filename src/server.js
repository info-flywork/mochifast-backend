import { setTimeout as sleep } from 'node:timers/promises';
import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config/index.js';
import { createLogger } from './infra/logger.js';
import { initSentry, flushSentry } from './infra/sentry.js';
import { createDatabase } from './infra/db.js';
import { createCacheRedis, createQueueRedis, connectSoftly, closeRedis } from './infra/redis.js';
import { createCache } from './infra/cache.js';
import { createMetrics, startMetricsServer } from './infra/metrics.js';
import { buildApp } from './app.js';

const config = loadConfig();
initSentry(config, 'api');
const logger = createLogger(config, { service: 'api' });

const db = createDatabase(config.db, { logger });
const cacheRedis = createCacheRedis(config.redis.cacheUrl, logger);
const queueRedis = createQueueRedis(config.redis.queueUrl, logger);
await Promise.all([connectSoftly(cacheRedis, logger), connectSoftly(queueRedis, logger)]);

const metrics = config.metrics.enabled
  ? createMetrics({ service: 'api', dbPoolStats: db.poolStats })
  : undefined;
const cache = createCache({
  client: cacheRedis,
  prefix: `${config.redis.keyPrefix}:${config.env}`,
  logger,
  metrics: metrics?.cache,
});

const app = await buildApp({
  config,
  logger,
  deps: { db, cacheRedis, queueRedis, cache, metrics },
});

app.addHook('onClose', async () => {
  await Promise.allSettled([db.close(), closeRedis(cacheRedis), closeRedis(queueRedis)]);
});

const metricsServer = metrics ? await startMetricsServer(metrics, config.metrics) : null;
await app.listen({ host: config.server.host, port: config.server.port });

// SIGTERM/SIGINT: readiness 503 → (LB'nin fark etmesi için) bekle → açık istekleri bitir → kapat.
closeWithGrace({ delay: config.server.shutdownGraceMs }, async ({ signal, err }) => {
  if (err) logger.error({ err }, 'beklenmeyen hata; kapanıyor');
  logger.info({ signal }, 'kapanış başladı');
  app.isShuttingDown = true;
  if (config.server.shutdownDrainMs > 0) await sleep(config.server.shutdownDrainMs);
  await app.close();
  metricsServer?.close();
  await flushSentry();
  logger.info('kapanış tamamlandı');
});
