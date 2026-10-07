import * as repo from '../modules/media/media.repository.js';
import { createMediaService } from '../modules/media/media.service.js';

/** 08 §6 yaşam döngüsü süreleri. */
export const MEDIA_RETENTION = Object.freeze({
  stuckProcessingHours: 1,
  unattachedMealPhotoHours: 24,
  deletedMealDays: 30,
});
const BATCH = 100;

/**
 * Medya temizliği (docs/backend/08-medya-bunny.md §6). Her iş küçük partilerle çalışır; bir
 * kaydın hatası diğerlerini durdurmaz, kayıt bir sonraki çalışmada tekrar denenir.
 */
export function mediaJobs({ db, storage, config, logger }) {
  const media = createMediaService({ db, storage, config, logger });

  async function destroyAll(rows, label) {
    let deleted = 0;
    for (const m of rows) {
      try {
        await media.destroy(m);
        deleted += 1;
      } catch (err) {
        logger.error({ err, mediaId: m.id }, `${label}: medya silinemedi`);
      }
    }
    if (deleted > 0) logger.info({ deleted }, label);
    return deleted;
  }

  return {
    /** > 1 sa `processing` kalan kayıt: yarım varyantlar silinir, `failed` olur. */
    async mediaStuck() {
      const rows = await repo.stuckProcessing(db, MEDIA_RETENTION.stuckProcessingHours, BATCH);
      for (const m of rows) {
        const zone = m.visibility === 'public' ? storage.public : storage.private;
        await Promise.allSettled(Object.values(m.variants).map((p) => zone.delete(p)));
        await repo.setStatus(db, m.id, 'failed');
      }
      if (rows.length > 0) logger.info({ failed: rows.length }, 'takılı medya kayıtları kapatıldı');
    },

    /** Analiz edilip kaydedilmeyen öğün fotoğrafları. */
    async mediaUnattached() {
      const rows = await repo.unattachedMealPhotos(
        db,
        MEDIA_RETENTION.unattachedMealPhotoHours,
        BATCH,
      );
      await destroyAll(rows, 'öğüne bağlanmamış fotoğraflar silindi');
    },

    /** 30 günden uzun süredir silinmiş öğünlerin fotoğrafları. */
    async mediaDeletedMeals() {
      const rows = await repo.photosOfDeletedMeals(db, MEDIA_RETENTION.deletedMealDays, BATCH);
      await destroyAll(rows, 'silinmiş öğünlerin fotoğrafları silindi');
    },
  };
}
