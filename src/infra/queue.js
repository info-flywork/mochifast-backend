import { Queue, Worker } from 'bullmq';
import { QUEUES } from '../config/constants.js';
import { queueConnectionOptions } from './redis.js';

/**
 * BullMQ kuyrukları. API yalnızca kuyruğa iş ATAR; işleri `worker` process'i tüketir,
 * tekrarlı işleri `scheduler` tanımlar (docs/backend/02-mimari.md §2).
 */

/** Varsayılan iş seçenekleri: üstel geri çekilme, bitenleri sınırlı tut. */
export const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
});

function bullPrefix(config) {
  return `${config.redis.keyPrefix}:${config.env}:bull`;
}

export function createQueues(config) {
  const connection = queueConnectionOptions(config.redis.queueUrl);
  const prefix = bullPrefix(config);
  return Object.fromEntries(
    Object.entries(QUEUES).map(([key, name]) => [
      key,
      new Queue(name, { connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
    ]),
  );
}

/**
 * Bir kuyruk için worker. İş adına göre handler seçer; bilinmeyen iş adı hatadır.
 */
export function createWorker(config, queueName, handlers, { concurrency = 5, logger } = {}) {
  const worker = new Worker(
    queueName,
    async (job) => {
      const handler = handlers[job.name];
      if (!handler) throw new Error(`"${queueName}" kuyruğunda bilinmeyen iş: ${job.name}`);
      return handler(job);
    },
    {
      connection: queueConnectionOptions(config.redis.queueUrl),
      prefix: bullPrefix(config),
      concurrency,
    },
  );
  worker.on('failed', (job, err) =>
    logger?.error({ queue: queueName, job: job?.name, jobId: job?.id, err }, 'iş başarısız'),
  );
  // Redis kesintisinde her yeniden bağlanma denemesi 'error' yayar; logu 10 sn'de bire indir.
  let lastErrorLog = 0;
  let suppressed = 0;
  worker.on('error', (err) => {
    const now = Date.now();
    if (now - lastErrorLog < 10_000) {
      suppressed += 1;
      return;
    }
    logger?.error({ queue: queueName, err: err.message, suppressed }, 'worker hatası');
    lastErrorLog = now;
    suppressed = 0;
  });
  return worker;
}
