import './config/env-file.js';
import { setTimeout as sleep } from 'node:timers/promises';
import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config/index.js';
import { createLogger } from './infra/logger.js';
import { initSentry, flushSentry } from './infra/sentry.js';
import { createDatabase } from './infra/db.js';
import { createMediaStorage } from './infra/bunny.js';
import { createCache } from './infra/cache.js';
import { createJobQueue } from './infra/queue.js';
import { createTokenService } from './infra/tokens.js';
import { createFieldCrypto } from './infra/crypto.js';
import { createFirebaseVerifier } from './infra/firebase-auth.js';
import { createMetrics, startMetricsServer } from './infra/metrics.js';
import { buildApp } from './app.js';

const config = loadConfig();
initSentry(config, 'api');
const logger = createLogger(config, { service: 'api' });

const db = createDatabase(config.db, { logger });

const metrics = config.metrics.enabled
  ? createMetrics({ service: 'api', dbPoolStats: db.poolStats })
  : undefined;
const cache = createCache({ maxEntries: config.cache.maxEntries, metrics: metrics?.cache });
const jobs = createJobQueue(db);
const tokens = await createTokenService(config.auth);
const crypto = createFieldCrypto(config.fieldEncryption);
const firebase = createFirebaseVerifier(config.firebase);
const storage = createMediaStorage(config.media, {
  logger,
  baseUrl: config.server.publicBaseUrl || `http://localhost:${config.server.port}`,
});
if (storage.driver === 'local')
  logger.warn({ dir: config.media.localDir }, 'medya yerel diske yazılıyor (MEDIA_DRIVER=local)');
if (!firebase.enabled) logger.warn('FIREBASE_PROJECT_ID yok: Apple/Google girişi kapalı');

const app = await buildApp({
  config,
  logger,
  deps: { db, cache, jobs, metrics, tokens, crypto, firebase, storage },
});

app.addHook('onClose', async () => {
  await db.close();
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
