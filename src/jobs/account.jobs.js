import { QUEUES } from '../config/constants.js';
import { createFieldCrypto } from '../infra/crypto.js';
import { createFirebaseUsers } from '../infra/firebase-users.js';
import { createJobQueue } from '../infra/queue.js';
import { createRevenueCatClient } from '../infra/revenuecat.js';
import * as repo from '../modules/account/account.repository.js';
import { EXPORT_TTL_DAYS } from '../modules/account/account.service.js';
import { createAccountDeletion } from '../modules/account/deletion.js';
import { buildExportZip, sha256 } from '../modules/account/export.js';
import { createRetention } from '../modules/account/retention.js';
import { ownerKey } from '../modules/media/media.pipeline.js';
import * as mediaRepo from '../modules/media/media.repository.js';
import * as notify from '../modules/notifications/notify.js';
import { newId } from '../shared/ids.js';

const SWEEP_BATCH = 100;

/**
 * `account` kuyruğu: hesap silme, veri dışa aktarma, saklama süreleri
 * (docs/backend/06-guvenlik.md §8). Dış istemciler testte enjekte edilebilir.
 */
export function accountJobs({ db, storage, config, logger, crypto, firebaseUsers, revenuecat }) {
  const jobs = createJobQueue(db);
  const deletion = createAccountDeletion({
    db,
    storage,
    firebaseUsers: firebaseUsers ?? createFirebaseUsers(config.push),
    revenuecat: revenuecat ?? createRevenueCatClient(config.billing, { logger }),
    config,
    logger,
  });
  const retention = createRetention({ db, logger });
  const fieldCrypto = crypto ?? createFieldCrypto(config.fieldEncryption);

  return {
    /** Süresi dolan silme talepleri → her biri ayrı iş (biri takılırsa diğerleri sürer). */
    async accountDeletionSweep() {
      const due = await repo.dueDeletions(db, SWEEP_BATCH);
      for (const r of due) {
        await jobs.enqueue(
          QUEUES.account,
          'accountDelete',
          { requestId: r.id },
          { maxAttempts: 5, dedupeKey: `account-delete:${r.id}` },
        );
      }
    },

    async accountDelete(job) {
      try {
        await deletion.execute(job.payload.requestId);
      } catch (err) {
        if (job.attempt >= job.maxAttempts) {
          logger.error({ err, requestId: job.payload.requestId }, 'hesap silme başarısız');
          await deletion.fail(job.payload.requestId, err);
          return;
        }
        throw err;
      }
    },

    /** Zip üretir, private zone'a yazar, kullanıcıya bildirim gönderir. */
    async dataExport(job) {
      const e = await repo.findExport(db, job.payload.exportId);
      if (!e || !['queued', 'processing'].includes(e.status)) return;
      await repo.setExportStatus(db, e.id, 'processing');
      try {
        const zip = await buildExportZip({ db, storage, crypto: fieldCrypto, logger }, e.userId);
        const mediaId = newId();
        const path = `u/${ownerKey(e.userId, config.media.pathSecret)}/exports/${e.id}.zip`;
        await mediaRepo.insertMedia(db, {
          id: mediaId,
          ownerUserId: e.userId,
          purpose: 'data_export',
          visibility: 'private',
          storagePath: path,
          variants: { zip: path },
          mime: 'application/zip',
          bytes: zip.length,
          width: null,
          height: null,
          blurhash: null,
          sha256: sha256(zip),
        });
        await storage.private.put(path, zip, 'application/zip');
        await mediaRepo.setStatus(db, mediaId, 'ready');
        await repo.setExportStatus(db, e.id, 'ready', {
          mediaId,
          bytes: zip.length,
          expiresAt: new Date(Date.now() + EXPORT_TTL_DAYS * 86_400_000),
        });
        await notify.schedule(db, null, e.userId, {
          type: 'data_export_ready',
          params: { exportId: e.id },
          dedupeKey: `export:${e.id}`,
        });
        logger.info({ exportId: e.id, bytes: zip.length }, 'veri dışa aktarma hazır');
      } catch (err) {
        if (job.attempt >= job.maxAttempts) {
          logger.error({ err, exportId: e.id }, 'veri dışa aktarma başarısız');
          await repo.setExportStatus(db, e.id, 'failed', { error: err.message });
          return;
        }
        await repo.setExportStatus(db, e.id, 'queued');
        throw err;
      }
    },

    /** 7 günü dolan dışa aktarma dosyaları silinir. */
    async dataExportExpire() {
      for (const e of await repo.expiredExports(db, SWEEP_BATCH)) {
        const media = e.mediaId ? await mediaRepo.findMedia(db, e.mediaId) : null;
        if (media && media.status !== 'deleted') {
          await storage.private.delete(media.variants.zip);
          await storage.private
            .purge(media.variants.zip)
            .catch((err) => logger.warn({ err }, 'dışa aktarma purge başarısız'));
          await mediaRepo.setStatus(db, media.id, 'deleted');
        }
        await repo.setExportStatus(db, e.id, 'expired');
      }
    },

    /** Günlük: süresi dolan kayıtlar (06 §8.4). Misafir hesaplar süreyle silinmez. */
    async accountRetention() {
      await retention.purgeExpiredRecords();
    },
  };
}
