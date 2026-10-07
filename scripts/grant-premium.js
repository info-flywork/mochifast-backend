import '../src/config/env-file.js';
import { loadConfig } from '../src/config/index.js';
import { createCache } from '../src/infra/cache.js';
import { createDatabase } from '../src/infra/db.js';
import { createJobQueue } from '../src/infra/queue.js';
import { createRevenueCatClient } from '../src/infra/revenuecat.js';
import {
  createBillingService,
  createEntitlements,
} from '../src/modules/billing/billing.service.js';
import { createCatalogService } from '../src/modules/catalog/catalog.service.js';
import { createPlansService } from '../src/modules/plans/plans.service.js';
import { createStatsService } from '../src/modules/stats/stats.service.js';

/**
 * Destek: kullanıcıya süreli promosyon premium (RevenueCat promotional entitlement) + senkron.
 * Yönetim paneli F10'da; o zamana kadar bu betik. İşlem audit'e yazılır.
 *
 *   npm run premium:grant -- <userId> <daily|three_day|weekly|monthly|two_month|three_month|six_month|yearly|lifetime>
 */
const DURATIONS = [
  'daily',
  'three_day',
  'weekly',
  'monthly',
  'two_month',
  'three_month',
  'six_month',
  'yearly',
  'lifetime',
];
const [userId, duration = 'monthly'] = process.argv.slice(2);
if (!userId || !DURATIONS.includes(duration)) {
  console.error(`Kullanım: npm run premium:grant -- <userId> <${DURATIONS.join('|')}>`);
  process.exit(1);
}

const config = loadConfig();
const db = createDatabase(config.db);
const cache = createCache();
try {
  const billing = createBillingService({
    db,
    jobs: createJobQueue(db),
    revenuecat: createRevenueCatClient(config.billing),
    entitlements: createEntitlements({ db, cache, config: config.billing }),
    plans: createPlansService({
      db,
      catalog: createCatalogService({ db, cache }),
      stats: createStatsService({ db }),
    }),
    config: config.billing,
  });
  const { after } = await billing.grantPromotional(userId, duration);
  console.log(`✔ ${userId}: premium=${after} (${duration})`);
} catch (err) {
  console.error('✖ premium verilemedi:', err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
