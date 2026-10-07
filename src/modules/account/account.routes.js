import { memoizeByDeps } from '../../shared/legacy.js';
import { createAccountService } from './account.service.js';
import * as s from './account.schemas.js';

export const accountServiceFor = memoizeByDeps((app) =>
  createAccountService({
    db: app.deps.db,
    cache: app.deps.cache,
    jobs: app.deps.jobs,
    storage: app.deps.storage,
    entitlements: app.deps.entitlements,
    firebase: app.deps.firebase,
  }),
);

const meta = (r) => ({ ip: r.ip, userAgent: r.headers['user-agent'] });

/** `/v1/user/me` hesap uçları (docs/backend/04-api.md §2 "Hesap & veri", 06 §8). */
export default async function accountRoutes(app) {
  const service = accountServiceFor(app);
  const auth = { preHandler: app.requireAuth };

  app.delete('/me', { ...auth, schema: s.deleteAccountSchema }, async (request, reply) => {
    reply.code(202);
    return service.requestDeletion(request.user.id, request.body ?? {}, meta(request));
  });

  app.post('/me/export', { ...auth, schema: s.requestExportSchema }, async (request, reply) => {
    reply.code(202);
    return service.requestExport(request.user.id);
  });

  app.get('/me/export/:id', { ...auth, schema: s.getExportSchema }, (request) =>
    service.getExport(request.user.id, request.params.id),
  );
}
