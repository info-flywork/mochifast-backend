import { memoizeByDeps } from '../../shared/legacy.js';
import { createNotificationsService } from './notifications.service.js';
import * as s from './notifications.schemas.js';

export const notificationsServiceFor = memoizeByDeps((app) =>
  // API yalnızca inbox okur; gönderim worker'da.
  createNotificationsService({
    db: app.deps.db,
    push: { enabled: false },
    jobs: app.deps.jobs,
    logger: app.log,
  }),
);

/** `/v1/notifications` (docs/backend/04-api.md §16). */
export default async function notificationsRoutes(app) {
  const service = notificationsServiceFor(app);
  const auth = { preHandler: app.requireAuth };
  app.get('/', { ...auth, schema: s.listSchema }, (request) =>
    // Accept-Language yoksa kullanıcının kayıtlı dili.
    service.list(
      request.user.id,
      request.headers['accept-language'] ? request.ctx.locale : null,
      request.query,
    ),
  );
  app.get('/unread-count', { ...auth, schema: s.unreadSchema }, (request) =>
    service.unreadCount(request.user.id),
  );
  app.post('/read-all', { ...auth, schema: s.readAllSchema }, (request) =>
    service.readAll(request.user.id),
  );
  app.post('/:id/read', { ...auth, schema: s.readSchema }, (request) =>
    service.read(request.user.id, request.params.id),
  );
  app.delete('/:id', { ...auth, schema: s.deleteSchema }, (request) =>
    service.remove(request.user.id, request.params.id),
  );
}
