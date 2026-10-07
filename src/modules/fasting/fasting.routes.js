import { memoizeByDeps } from '../../shared/legacy.js';
import { contentServiceFor } from '../catalog/catalog.routes.js';
import { plansServiceFor } from '../plans/plans.routes.js';
import { createFastingService } from './fasting.service.js';
import {
  activeSchema,
  cancelSchema,
  finishSchema,
  getSchema,
  listSchema,
  manualSchema,
  removeSchema,
  startSchema,
  struggleSchema,
  struggleWithFastSchema,
  updateSchema,
} from './fasting.schemas.js';

export const fastingServiceFor = memoizeByDeps((app) =>
  createFastingService({
    db: app.deps.db,
    crypto: app.deps.crypto,
    plans: plansServiceFor(app),
    content: contentServiceFor(app),
  }),
);

/**
 * `/v1/fasts` (docs/backend/04-api.md §6). Yazma uçları Idempotency-Key destekler.
 */
export default async function fastingRoutes(app) {
  const service = fastingServiceFor(app);
  const read = { preHandler: app.requireAuth };
  const write = { preHandler: [app.requireAuth, app.idempotent] };
  const meta = (r) => ({ ip: r.ip, userAgent: r.headers['user-agent'] });

  app.get('/active', { ...read, schema: activeSchema }, (request) =>
    service.active(request.user.id, request.ctx.locale),
  );

  app.post('/', { ...write, schema: startSchema }, async (request, reply) => {
    const result = await service.start(
      request.user.id,
      request.body ?? {},
      meta(request),
      request.ctx.locale,
    );
    reply.code(result.created ? 201 : 200);
    return { fast: result.fast };
  });

  app.post('/manual', { ...write, schema: manualSchema }, async (request, reply) => {
    reply.code(201);
    return service.manual(request.user.id, request.body, meta(request));
  });

  app.get('/', { ...read, schema: listSchema }, (request) =>
    service.list(request.user.id, request.query),
  );

  app.get('/:id', { ...read, schema: getSchema }, (request) =>
    service.get(request.user.id, request.params.id),
  );

  app.patch('/:id', { ...write, schema: updateSchema }, (request) =>
    service.update(request.user.id, request.params.id, request.body, meta(request)),
  );

  app.post('/:id/finish', { ...write, schema: finishSchema }, (request) =>
    service.finish(request.user.id, request.params.id, request.body ?? {}, meta(request)),
  );

  app.post('/:id/cancel', { ...write, schema: cancelSchema }, (request) =>
    service.cancel(request.user.id, request.params.id, meta(request)),
  );

  app.delete('/:id', { ...write, schema: removeSchema }, (request) =>
    service.remove(request.user.id, request.params.id, meta(request)),
  );

  app.post(
    '/:id/struggles',
    { ...write, schema: struggleWithFastSchema },
    async (request, reply) => {
      reply.code(201);
      return service.logStruggle(request.user.id, request.params.id, request.body);
    },
  );
}

/** `/v1/struggles` — oruç olmadan zorlanma kaydı. */
export async function strugglesRoutes(app) {
  const service = fastingServiceFor(app);
  app.post(
    '/',
    { preHandler: [app.requireAuth, app.idempotent], schema: struggleSchema },
    async (request, reply) => {
      reply.code(201);
      return service.logStruggle(request.user.id, null, request.body);
    },
  );
}
