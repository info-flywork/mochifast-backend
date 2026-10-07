import { memoizeByDeps } from '../../shared/legacy.js';
import { plansServiceFor } from '../plans/plans.routes.js';
import { createBillingService } from './billing.service.js';
import * as s from './billing.schemas.js';

export const billingServiceFor = memoizeByDeps((app) =>
  createBillingService({
    db: app.deps.db,
    jobs: app.deps.jobs,
    revenuecat: app.deps.revenuecat,
    entitlements: app.deps.entitlements,
    plans: plansServiceFor(app),
    config: app.config.billing,
    logger: app.log,
  }),
);

const meta = (r) => ({ ip: r.ip, userAgent: r.headers['user-agent'] });

/** `/v1/subscription` (docs/backend/04-api.md §17). Paywall istemcide (RevenueCat Paywalls). */
export async function subscriptionRoutes(app) {
  const billing = billingServiceFor(app);
  app.get('/', { preHandler: app.requireAuth, schema: s.getSchema }, (request) =>
    billing.get(request.user.id),
  );
  app.post(
    '/sync',
    {
      preHandler: app.requireAuth,
      schema: s.syncSchema,
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    (request) => billing.clientSync(request.user.id, meta(request)),
  );
}

/** `/v1/webhooks/revenuecat` — kullanıcı oturumu yok; RevenueCat'in Authorization başlığı. */
export async function webhookRoutes(app) {
  const billing = billingServiceFor(app);
  app.post('/revenuecat', { schema: s.webhookSchema }, (request) =>
    billing.receiveWebhook(request.headers.authorization, request.body),
  );
}
