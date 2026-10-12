import { writeAudit } from '../audit/audit.repository.js';
import { ownerKey } from '../media/media.pipeline.js';
import * as repo from './account.repository.js';

/**
 * Süresi dolan hesap silme talebini yürütür (docs/backend/06-guvenlik.md §8.3). Her adım
 * idempotenttir: iş yarıda kalırsa baştan tekrar çalışır.
 *
 * 1. Firebase Authentication kullanıcısı silinir (Apple/Google token iptali istemcide yapılır).
 * 2. Private zone'daki `u/<ownerKey>/` ve public zone'daki `avatars/<ownerKey>/` dizinleri silinir,
 *    CDN önbelleği temizlenir.
 * 3. RevenueCat müşteri kaydı silinir.
 * 4. Kullanıcı satırı silinir: kişisel tablolar FK cascade ile gider; denetim izi anonimleşir.
 */
export function createAccountDeletion({ db, storage, firebaseUsers, revenuecat, config, logger }) {
  async function deleteDir(zone, prefix) {
    const paths = await zone.list(prefix);
    for (const path of paths) await zone.delete(path);
    if (paths.length > 0) {
      await zone
        .purge(`${prefix}*`)
        .catch((err) => logger.warn({ err }, 'hesap silme: CDN purge başarısız'));
    }
    return paths.length;
  }

  async function deleteFiles(userId) {
    const key = ownerKey(userId, config.media.pathSecret);
    return (
      (await deleteDir(storage.private, `u/${key}/`)) +
      (await deleteDir(storage.public, `avatars/${key}/`))
    );
  }

  return {
    /** @returns 'completed' | 'skipped' */
    async execute(requestId) {
      const request = await repo.findDeletion(db, requestId);
      if (!request || request.status !== 'scheduled' || request.scheduledFor > new Date()) {
        return 'skipped';
      }
      const { userId } = request;

      let firebaseDeleted = 0;
      for (const uid of await repo.firebaseSubjects(db, userId)) {
        if (await firebaseUsers.deleteUser(uid)) firebaseDeleted += 1;
      }
      const files = await deleteFiles(userId);
      if (revenuecat.enabled) await revenuecat.deleteSubscriber(userId);
      const users = await repo.purgeUser(db, userId);

      await repo.finishDeletion(db, requestId, { status: 'completed' });
      // Kullanıcı kimliği yazılmaz: kayıt talep üzerinden izlenir.
      await writeAudit(db, {
        actorType: 'system',
        action: 'account.deleted',
        entityType: 'account_deletion_request',
        entityId: requestId,
        metadata: { source: request.source, files, firebaseDeleted, users },
      });
      logger.info({ requestId, source: request.source, files }, 'hesap silindi');
      return 'completed';
    },

    async fail(requestId, err) {
      await repo.finishDeletion(db, requestId, { status: 'failed', error: err?.message ?? err });
    },
  };
}
