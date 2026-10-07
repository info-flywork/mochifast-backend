import './config/env-file.js';
import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config/index.js';
import { QUEUES } from './config/constants.js';
import { createLogger } from './infra/logger.js';
import { initSentry, flushSentry } from './infra/sentry.js';
import { createDatabase } from './infra/db.js';
import { createScheduler, createWorker } from './infra/queue.js';
import { SCHEDULES } from './schedules.js';
import { createMediaStorage } from './infra/bunny.js';
import { createFieldCrypto } from './infra/crypto.js';
import { aiJobs } from './jobs/ai.jobs.js';
import { billingJobs } from './jobs/billing.jobs.js';
import { mediaJobs } from './jobs/media.jobs.js';
import { statsJobs } from './jobs/stats.jobs.js';
import { systemJobs } from './jobs/system.jobs.js';
import { createStatsService } from './modules/stats/stats.service.js';

/**
 * Kuyruk tüketicisi + tekrarlı iş zamanlayıcısı. Ağır/yavaş işler (görsel işleme, AI analizi,
 * push, rollup…) API'de değil burada çalışır. Yeni kuyruklar fazlarla eklenir.
 */
const config = loadConfig();
initSentry(config, 'worker');
const logger = createLogger(config, { service: 'worker' });
const db = createDatabase(config.db, { logger });

const scheduler = createScheduler({ db, schedules: SCHEDULES, logger });
try {
  logger.info(await scheduler.sync(), 'zamanlamalar eşitlendi');
} catch (err) {
  // DB erişilemiyor ya da migration çalışmamış: çık, PM2 yeniden başlatır.
  logger.fatal({ err }, 'zamanlamalar eşitlenemedi');
  await db.close();
  process.exit(1);
}
scheduler.start();

const storage = createMediaStorage(config.media, { logger });

const workers = [
  createWorker({
    db,
    queue: QUEUES.system,
    handlers: systemJobs({ db, logger }),
    concurrency: config.worker.concurrency,
    pollMs: config.worker.pollMs,
    logger,
  }),
  createWorker({
    db,
    queue: QUEUES.stats,
    handlers: statsJobs({ db, stats: createStatsService({ db }), logger }),
    // Yeniden hesaplamalar kullanıcı satırını kilitler; az eşzamanlılık API'yi rahat bırakır.
    concurrency: 1,
    pollMs: config.worker.pollMs,
    logger,
  }),
  createWorker({
    db,
    queue: QUEUES.media,
    handlers: mediaJobs({ db, storage, config: config.media, logger }),
    concurrency: 1,
    pollMs: config.worker.pollMs,
    logger,
  }),
  createWorker({
    db,
    queue: QUEUES.ai,
    handlers: aiJobs({
      db,
      storage,
      config,
      logger,
      crypto: createFieldCrypto(config.fieldEncryption),
    }),
    // Analiz 5–15 sn sürer (dış çağrı); paralel işlenir, CPU'yu meşgul etmez.
    concurrency: 4,
    timeoutMs: 120_000,
    pollMs: config.worker.pollMs,
    logger,
  }),
  createWorker({
    db,
    queue: QUEUES.billing,
    handlers: billingJobs({ db, config, logger }),
    concurrency: 2,
    pollMs: config.worker.pollMs,
    logger,
  }),
];

logger.info({ queues: workers.map((w) => w.name) }, 'worker hazır');

closeWithGrace({ delay: config.server.shutdownGraceMs }, async ({ signal, err }) => {
  if (err) logger.error({ err }, 'beklenmeyen hata; kapanıyor');
  logger.info({ signal }, 'worker kapanıyor (aktif işler bitirilecek)');
  await scheduler.close();
  await Promise.allSettled(workers.map((w) => w.close()));
  await db.close();
  await flushSentry();
});
