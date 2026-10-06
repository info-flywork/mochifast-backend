import { loadConfig } from './config/index.js';
import { createLogger } from './infra/logger.js';
import { createQueues } from './infra/queue.js';
import { syncSchedules } from './schedules.js';

/**
 * Tekrarlı işleri (BullMQ job scheduler) Redis'e kaydeder ve çıkar.
 * BullMQ job scheduler'ları Redis'te yaşar; bir sonraki tekrarı worker üretir — sürekli çalışan
 * bir zamanlayıcı process'i GEREKMEZ. Her deploy'da (release adımı) bir kez çalıştırılır;
 * idempotenttir ve tanımdan kaldırılan zamanlamaları siler.
 */
const TIMEOUT_MS = 30_000;

const config = loadConfig();
const logger = createLogger(config, { service: 'scheduler' });
const queues = createQueues(config);

// Deploy adımı Redis erişilemezken sonsuza dek takılmasın.
const timeout = setTimeout(() => {
  logger.error(
    { timeoutMs: TIMEOUT_MS },
    'zamanlama senkronu zaman aşımına uğradı (Redis erişilebilir mi?)',
  );
  process.exit(1);
}, TIMEOUT_MS);

try {
  const result = await syncSchedules(queues);
  logger.info(result, 'zamanlamalar senkronlandı');
} catch (err) {
  logger.error({ err }, 'zamanlama senkronu başarısız');
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await Promise.allSettled(Object.values(queues).map((q) => q.close()));
}
