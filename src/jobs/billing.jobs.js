import { createCache } from '../infra/cache.js';
import { createJobQueue } from '../infra/queue.js';
import { createRevenueCatClient } from '../infra/revenuecat.js';
import { createBillingService, createEntitlements } from '../modules/billing/billing.service.js';
import { createCatalogService } from '../modules/catalog/catalog.service.js';
import { createPlansService } from '../modules/plans/plans.service.js';
import { createStatsService } from '../modules/stats/stats.service.js';

/**
 * `billing` kuyruğu (docs/backend/11-abonelik.md §3, §5). Bağımlılıklar testte enjekte edilebilir.
 */
export function billingJobs({ db, config, logger, revenuecat, cache = createCache() }) {
  const entitlements = createEntitlements({ db, cache, config: config.billing });
  const plans = createPlansService({
    db,
    catalog: createCatalogService({ db, cache }),
    stats: createStatsService({ db }),
  });
  const billing = createBillingService({
    db,
    jobs: createJobQueue(db),
    revenuecat: revenuecat ?? createRevenueCatClient(config.billing, { logger }),
    entitlements,
    plans,
    config: config.billing,
    logger,
  });

  return {
    /** Webhook olayı: abonenin güncel durumu RevenueCat'ten çekilip yazılır. */
    async revenuecatEvent(job) {
      await billing.processEvent(job.payload.eventId);
    },

    /** Premium kaybı: bitişin ertesi yerel gününde premium plan 16:8'e düşer, inbox kaydı. */
    async premiumDowngrade() {
      const downgraded = await billing.downgradeExpired();
      if (downgraded > 0)
        logger.info({ downgraded }, 'premium planlar ücretsiz eşdeğerine düşürüldü');
    },
  };
}
