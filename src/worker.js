import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config/index.js';
import { QUEUES } from './config/constants.js';
import { createLogger } from './infra/logger.js';
import { initSentry, flushSentry } from './infra/sentry.js';
import { createWorker } from './infra/queue.js';
import { systemJobs } from './jobs/system.jobs.js';

/**
 * Kuyruk tüketicisi. Ağır/yavaş işler (görsel işleme, AI analizi, push, rollup…)
 * API'de değil burada çalışır. Yeni kuyruklar fazlarla eklenir.
 */
const config = loadConfig();
initSentry(config, 'worker');
const logger = createLogger(config, { service: 'worker' });

const workers = [
  createWorker(config, QUEUES.system, systemJobs({ logger }), { concurrency: 2, logger }),
];

logger.info({ queues: workers.map((w) => w.name) }, 'worker hazır');

closeWithGrace({ delay: config.server.shutdownGraceMs }, async ({ signal, err }) => {
  if (err) logger.error({ err }, 'beklenmeyen hata; kapanıyor');
  logger.info({ signal }, 'worker kapanıyor (aktif işler bitirilecek)');
  await Promise.allSettled(workers.map((w) => w.close()));
  await flushSentry();
});
