import { grantsAccess, mapSubscriber, webhookAuthorized } from '../../infra/revenuecat.js';
import { AppError } from '../../shared/errors.js';
import { toBin } from '../../shared/ids.js';
import { isValidTimezone, localDate } from '../../shared/time.js';
import { writeAudit } from '../audit/audit.repository.js';
import { FREE_FALLBACK_PLAN } from '../plans/plans.rules.js';
import * as userRepo from '../user/user.repository.js';
import * as repo from './billing.repository.js';

const ENT_TTL_SEC = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Premium kararı (tek yer): abonelik yansımasından, kısa süre process içinde önbelleklenir.
 * Webhook'u worker işlediği için API önbelleği en geç TTL kadar eski kalır; istemci satın
 * alma sonrası `POST /subscription/sync` çağırır (anında, önbelleği de temizler).
 */
export function createEntitlements({ db, cache, config }) {
  const key = (userId) => `ent:${userId}`;
  const ent = {
    async isPremium(userId) {
      if (!userId) return false;
      return cache.getOrSet(key(userId), ENT_TTL_SEC, async () => {
        const s = await repo.findSubscription(db, userId, config.entitlement);
        if (!s) return false;
        if (s.environment === 'sandbox' && !config.allowSandbox) return false;
        return grantsAccess(s);
      });
    },
    async invalidate(userId) {
      await cache.del(key(userId));
    },
  };
  return ent;
}

/**
 * Abonelik (docs/backend/11-abonelik.md). Paywall istemcide (RevenueCat Paywalls); sunucu
 * yalnızca durumu yansıtır ve yetki kararını verir.
 */
export function createBillingService({
  db,
  jobs,
  revenuecat,
  entitlements,
  plans,
  config,
  logger,
}) {
  function toDto(s, isPremium) {
    return {
      isPremium,
      entitlement: config.entitlement,
      status: s?.status ?? null,
      productId: s?.productId ?? null,
      store: s?.store ?? null,
      environment: s?.environment ?? null,
      periodType: s?.periodType ?? null,
      willRenew: s?.willRenew ?? false,
      expiresAt: s?.expiresAt ? s.expiresAt.toISOString() : null,
      graceExpiresAt: s?.graceExpiresAt ? s.graceExpiresAt.toISOString() : null,
      managementUrl: s?.managementUrl ?? null,
    };
  }

  /** Onboarding'de seçilip premium olmadığı için bekleyen plan, premium gelince etkinleşir. */
  async function activatePendingPlan(userId) {
    const [profile, current] = await Promise.all([
      userRepo.getProfile(db, userId),
      plans.findCurrent(userId),
    ]);
    const pending = profile?.plan_code;
    if (!pending || pending === current?.planCode) return;
    try {
      await plans.activate(userId, { planCode: pending }, { hasPremium: true, skipSafety: true });
    } catch (err) {
      // Bekleyen plan artık geçersiz olabilir (ör. özel plan pencere ister); premium yine verilir.
      logger?.warn({ err, userId, planCode: pending }, 'bekleyen premium plan etkinleştirilemedi');
    }
  }

  const service = {
    async get(userId) {
      const s = await repo.findSubscription(db, userId, config.entitlement);
      return { subscription: toDto(s, await entitlements.isPremium(userId)) };
    },

    /**
     * RevenueCat'ten güncel durumu çekip yazar (webhook işi ve istemci senkronu).
     * @returns {before, after} premium durumu
     */
    async sync(userId, { source = 'client', meta = {} } = {}) {
      const before = await entitlements.isPremium(userId);
      const body = await revenuecat.subscriber(userId);
      const mapped = mapSubscriber(body, config.entitlement);
      await db.withTransaction(async (conn) => {
        await db.one('SELECT id FROM users WHERE id = :id FOR UPDATE', { id: toBin(userId) }, conn);
        if (mapped) await repo.upsertSubscription(db, conn, userId, config.entitlement, mapped);
        else await repo.expireSubscription(db, conn, userId, config.entitlement);
      });
      await entitlements.invalidate(userId);
      const after = await entitlements.isPremium(userId);
      if (before !== after) {
        await writeAudit(db, {
          actorType: { client: 'user', webhook: 'webhook', admin: 'admin' }[source] ?? 'system',
          actorId: source === 'client' ? userId : null,
          action: 'subscription.changed',
          entityType: 'user',
          entityId: userId,
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: { isPremium: after, status: mapped?.status ?? 'expired', source },
        });
      }
      if (after && !before) await activatePendingPlan(userId);
      return { before, after };
    },

    /** POST /v1/subscription/sync */
    async clientSync(userId, meta) {
      await service.sync(userId, { source: 'client', meta });
      return service.get(userId);
    },

    /**
     * POST /v1/webhooks/revenuecat — yetki, idempotent kayıt, kuyruk; hızlı 200 (RevenueCat
     * birkaç saniye içinde yanıt bekler, işleme asenkron).
     */
    async receiveWebhook(authorization, body) {
      if (!config.webhookAuth) {
        throw new AppError('UNAVAILABLE', { details: { reason: 'billing_disabled' } });
      }
      if (!webhookAuthorized(authorization, config.webhookAuth))
        throw new AppError('UNAUTHENTICATED');
      const event = body?.event;
      if (!event?.id || !event?.type) {
        throw new AppError('VALIDATION_FAILED', {
          details: { fields: [{ path: 'event', message: 'is required' }] },
        });
      }
      const fresh = await repo.insertEvent(db, {
        id: String(event.id).slice(0, 80),
        type: String(event.type).slice(0, 40),
        appUserId: String(event.app_user_id ?? '').slice(0, 120),
        environment: String(event.environment ?? '').slice(0, 20),
        payload: body,
      });
      if (fresh) {
        await jobs.enqueue(
          'billing',
          'revenuecatEvent',
          { eventId: event.id },
          {
            maxAttempts: 5,
            dedupeKey: `rc:${event.id}`,
          },
        );
      }
      return { received: true, duplicate: !fresh };
    },

    /** Worker: olayın kullanıcılarını RevenueCat'ten senkronlar (TRANSFER: iki taraf). */
    async processEvent(eventId) {
      const e = await repo.findEvent(db, eventId);
      if (!e || e.processed_at) return;
      const ev = e.payload.event ?? {};
      if (ev.type === 'TEST') return repo.markEvent(db, eventId);
      const ids = new Set(
        [
          ev.app_user_id,
          ev.original_app_user_id,
          ...(ev.transferred_from ?? []),
          ...(ev.transferred_to ?? []),
        ]
          .filter(Boolean)
          .map(String),
      );
      const known = [];
      for (const id of ids) {
        if (UUID.test(id) && (await repo.userExists(db, id))) known.push(id);
      }
      if (known.length === 0) {
        // İstemci `Purchases.logIn(userId)` çağırmadan satın almış ($RCAnonymousID): sync düzeltir.
        const anonymous = [...ids].every((id) => id.startsWith('$RCAnonymousID:'));
        if (!anonymous)
          logger?.error({ eventId, type: ev.type }, 'RevenueCat olayı bilinmeyen kullanıcı');
        return repo.markEvent(db, eventId, anonymous ? 'anonymous_user' : 'unknown_user');
      }
      for (const userId of known) await service.sync(userId, { source: 'webhook' });
      await repo.markEvent(db, eventId);
    },

    /**
     * Premium kaybı (11 §5): erişimi biten kullanıcının premium planı, bitişin ERTESİ yerel
     * gününde ücretsiz eşdeğerine (16:8) düşer; inbox kaydı yazılır. Aktif oruç bozulmaz
     * (hedef seansta saklı).
     */
    async downgradeExpired({ now = new Date() } = {}) {
      const rows = await repo.premiumPlansWithoutAccess(db, config.entitlement, 0, 200);
      let downgraded = 0;
      for (const r of rows) {
        const tz = isValidTimezone(r.timezone) ? r.timezone : 'UTC';
        if (r.expiresAt && localDate(r.expiresAt, tz) >= localDate(now, tz)) continue;
        if (await entitlements.isPremium(r.userId)) continue;
        try {
          await db.withTransaction(async (conn) => {
            await plans.activate(
              r.userId,
              { planCode: FREE_FALLBACK_PLAN },
              { conn, hasPremium: false, skipSafety: true, meta: {} },
            );
            await repo.insertNotification(db, conn, r.userId, {
              type: 'premium_expired',
              params: { fromPlan: r.planCode, toPlan: FREE_FALLBACK_PLAN },
            });
          });
          downgraded += 1;
        } catch (err) {
          logger?.error({ err, userId: r.userId }, 'premium plan düşürülemedi');
        }
      }
      return downgraded;
    },

    /** Destek/admin: süreli promosyon premium (RevenueCat) + anında senkron. Panel F10'da. */
    async grantPromotional(userId, duration, { actorId } = {}) {
      await revenuecat.grantPromotional(userId, config.entitlement, duration);
      const result = await service.sync(userId, { source: 'admin' });
      await writeAudit(db, {
        actorType: 'admin',
        actorId: actorId ?? null,
        action: 'subscription.promotional_granted',
        entityType: 'user',
        entityId: userId,
        metadata: { duration },
      });
      return result;
    },
  };
  return service;
}
