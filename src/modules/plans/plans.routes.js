import { memoizeByDeps } from '../../shared/legacy.js';
import { catalogServiceFor } from '../catalog/catalog.routes.js';
import { createPlansService } from './plans.service.js';
import {
  checkinSchema,
  getCurrentSchema,
  historySchema,
  putCurrentSchema,
} from './plans.schemas.js';

export const plansServiceFor = memoizeByDeps((app) =>
  createPlansService({ db: app.deps.db, catalog: catalogServiceFor(app) }),
);

/** Premium entitlement F8'de bağlanır. */
const hasPremium = () => false;

/**
 * `/v1/plans` (docs/backend/04-api.md §5).
 */
export default async function plansRoutes(app) {
  const service = plansServiceFor(app);
  const auth = { preHandler: app.requireAuth };
  const meta = (r) => ({ ip: r.ip, userAgent: r.headers['user-agent'] });

  app.get('/current', { ...auth, schema: getCurrentSchema }, (request) =>
    service.current(request.user.id, request.ctx.locale),
  );

  app.put('/current', { ...auth, schema: putCurrentSchema }, (request) =>
    service.activateAndGet(
      request.user.id,
      request.body,
      { hasPremium: hasPremium(request.user), meta: meta(request) },
      request.ctx.locale,
    ),
  );

  app.put('/days/:date', { ...auth, schema: checkinSchema }, (request) =>
    service.checkin(request.user.id, request.params.date, request.body.status),
  );

  app.get('/history', { ...auth, schema: historySchema }, (request) =>
    service.history(request.user.id, request.ctx.locale, request.query),
  );
}
