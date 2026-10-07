import { createAiClient } from '../infra/anthropic.js';
import { createCache } from '../infra/cache.js';
import { createJobQueue } from '../infra/queue.js';
import { createAiGate } from '../modules/ai/ai.gate.js';
import * as aiRepo from '../modules/ai/ai.repository.js';
import * as repo from '../modules/ai/photo-analysis.repository.js';
import { createPhotoAnalysisService } from '../modules/ai/photo-analysis.service.js';
import { createCatalogService } from '../modules/catalog/catalog.service.js';
import { createMediaService } from '../modules/media/media.service.js';

/** Kuyruk işi bu süreyi aşan analiz kaydı (worker çöktü) kapatılır, kota iade edilir. */
const STUCK_MINUTES = 15;

/**
 * `ai` kuyruğu (docs/backend/09-yapay-zeka.md §3.1). Bağımlılıklar testte enjekte edilebilir.
 */
export function aiJobs({ db, storage, config, logger, ai, cache = createCache() }) {
  const client = ai ?? createAiClient(config.ai, { logger });
  const gate = createAiGate({ db, catalog: createCatalogService({ db, cache }), cache });
  const media = createMediaService({ db, storage, config: config.media, logger });
  const analyses = createPhotoAnalysisService({
    db,
    jobs: createJobQueue(db),
    gate,
    media,
    ai: client,
    storage,
    config: config.ai,
    logger,
  });

  return {
    async photoAnalysis(job) {
      await analyses.run(job.payload.analysisId, {
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
      });
    },

    /** 3 günden eski kota sayaçları. */
    async aiQuotaCleanup() {
      const deleted = await aiRepo.deleteOldQuota(db);
      if (deleted > 0) logger.info({ deleted }, 'eski AI kota satırları silindi');
    },

    /** Kuyrukta ölmüş analizler `failed` olur, kota iade edilir (istemci sonsuza dek yoklamasın). */
    async aiStuckAnalyses() {
      const rows = await repo.stuckAnalyses(db, STUCK_MINUTES, 100);
      for (const a of rows) {
        await repo.complete(db, a.id, { status: 'failed', errorCode: 'TIMEOUT' });
        await gate.refund(a.userId, 'photo_analysis', a.quotaDate);
      }
      if (rows.length > 0) logger.warn({ closed: rows.length }, 'takılı analizler kapatıldı');
    },
  };
}
