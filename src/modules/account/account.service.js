import { QUEUES } from '../../config/constants.js';
import { sessionCachePrefix } from '../../plugins/auth.js';
import { AppError } from '../../shared/errors.js';
import { writeAudit } from '../audit/audit.repository.js';
import { clearPushTokens, revokeUserSessions } from '../auth/auth.repository.js';
import { findMedia } from '../media/media.repository.js';
import * as notify from '../notifications/notify.js';
import * as repo from './account.repository.js';

/** Hesap silme bekleme süresi (14 #16). */
export const DELETION_GRACE_DAYS = 7;
/** Dışa aktarma: günde 1 talep, dosya 7 gün saklanır. */
export const EXPORT_WINDOW_HOURS = 24;
export const EXPORT_TTL_DAYS = 7;
/** İmzalı indirme linkinin ömrü (her GET'te yenisi verilir). */
const EXPORT_URL_TTL_SEC = 3_600;
const HEALTH_CONSENT_TTL_SEC = 60;

const DAY_MS = 86_400_000;

export const healthConsentKey = (userId) => `consent:health:${userId}`;

/**
 * Hesap silme talebi, veri dışa aktarma ve rıza kontrolü (docs/backend/06-guvenlik.md §8).
 * Ağır işler (silme, zip) worker'da: jobs/account.jobs.js.
 */
export function createAccountService({ db, cache, jobs, storage, entitlements }) {
  function exportDto(e) {
    return {
      id: e.id,
      status: e.status,
      requestedAt: e.requestedAt.toISOString(),
      completedAt: e.completedAt?.toISOString() ?? null,
      expiresAt: e.expiresAt?.toISOString() ?? null,
      bytes: e.bytes,
      url: null,
      urlExpiresAt: null,
    };
  }

  return {
    /**
     * Hesap silme talebi: hesap hemen kapanır (oturumlar, push), veriler bekleme süresi sonunda
     * silinir. Tekrar çağrı aynı talebi döner.
     */
    async requestDeletion(userId, body, meta) {
      const scheduledFor = await db.withTransaction(async (conn) => {
        const existing = await repo.scheduledDeletion(db, userId, conn);
        if (existing) return existing.scheduledFor;
        const at = new Date(Date.now() + DELETION_GRACE_DAYS * DAY_MS);
        const requestId = await repo.insertDeletionRequest(db, conn, {
          userId,
          source: 'user',
          scheduledFor: at,
          reason: body.reason?.trim() || null,
        });
        await repo.setUserStatus(db, conn, userId, 'pending_deletion');
        await revokeUserSessions(db, conn, userId, 'account_deleted');
        await clearPushTokens(db, conn, userId, null);
        await notify.cancel(db, conn, userId, '');
        await writeAudit(
          db,
          {
            actorType: 'user',
            actorId: userId,
            action: 'account.delete_requested',
            entityType: 'account_deletion_request',
            entityId: requestId,
            ip: meta.ip,
            userAgent: meta.userAgent,
          },
          conn,
        );
        return at;
      });
      await cache.delPrefix(sessionCachePrefix(userId));
      // Mağaza aboneliği uygulamadan iptal edilemez; istemci kullanıcıya bunu söyler.
      const hasActiveSubscription = (await entitlements?.isPremium(userId)) ?? false;
      return { scheduledFor: scheduledFor.toISOString(), hasActiveSubscription };
    },

    /** Son 24 saatte talep varsa o döner (günde 1); yoksa yeni talep kuyruğa girer. */
    async requestExport(userId) {
      const e = await db.withTransaction(async (conn) => {
        const since = new Date(Date.now() - EXPORT_WINDOW_HOURS * 3_600_000);
        const recent = await repo.recentExport(db, conn, userId, since);
        if (recent) return recent;
        const id = await repo.insertExport(db, conn, userId);
        await jobs.enqueue(
          QUEUES.account,
          'dataExport',
          { exportId: id },
          { conn, maxAttempts: 3, dedupeKey: `export:${id}` },
        );
        return repo.findExport(db, id, conn);
      });
      return { export: exportDto(e) };
    },

    async getExport(userId, id) {
      const e = await repo.findExport(db, id);
      if (!e || e.userId !== userId) throw new AppError('NOT_FOUND');
      const dto = exportDto(e);
      if (e.status === 'ready' && e.mediaId && e.expiresAt > new Date()) {
        const media = await findMedia(db, e.mediaId);
        if (media?.status === 'ready') {
          const ttlSec = Math.min(
            EXPORT_URL_TTL_SEC,
            Math.floor((e.expiresAt.getTime() - Date.now()) / 1000),
          );
          const signed = storage.signPrivateUrl(media.variants.zip, { ttlSec });
          dto.url = signed.url;
          dto.urlExpiresAt = signed.expiresAt;
        }
      }
      return { export: dto };
    },

    /**
     * Sağlık verisi rızası açıkça geri çekildiyse sağlık kaydı yazılamaz (06 §8.1). Hiç kayıt
     * yoksa (eski hesaplar) engellenmez; silme her zaman serbesttir.
     */
    async assertHealthConsent(userId) {
      // null cache'lenmez: durum metin olarak tutulur.
      const state = await cache.getOrSet(
        healthConsentKey(userId),
        HEALTH_CONSENT_TTL_SEC,
        async () => {
          const granted = await repo.latestConsent(db, userId, 'health_data');
          if (granted === null) return 'none';
          return granted ? 'granted' : 'withdrawn';
        },
      );
      if (state === 'withdrawn') {
        throw new AppError('CONSENT_REQUIRED', { details: { consent: 'healthData' } });
      }
    },
  };
}
