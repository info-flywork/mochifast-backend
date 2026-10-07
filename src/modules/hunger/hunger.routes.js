import { memoizeByDeps } from '../../shared/legacy.js';
import { contentServiceFor } from '../catalog/catalog.routes.js';
import { trackerContextFor } from '../trackers/trackers.routes.js';
import { createHungerService } from './hunger.service.js';
import * as s from './hunger.schemas.js';

const hungerServiceFor = memoizeByDeps((app) =>
  createHungerService({
    db: app.deps.db,
    crypto: app.deps.crypto,
    ctx: trackerContextFor(app),
    content: contentServiceFor(app),
  }),
);

/** `/v1/hunger-checkins` (docs/backend/04-api.md §12). */
export default async function hungerRoutes(app) {
  const hunger = hungerServiceFor(app);
  const read = { preHandler: app.requireAuth };
  const write = { preHandler: [app.requireAuth, app.requireHealthConsent, app.idempotent] };

  app.post('/evaluate', { ...read, schema: s.evaluateSchema }, (request) =>
    hunger.evaluate(request.user.id, request.body ?? {}, request.ctx.locale),
  );
  app.get('/summary', { ...read, schema: s.summarySchema }, (request) =>
    hunger.summary(request.user.id, request.query.date),
  );
  app.post('/', { ...write, schema: s.createSchema }, async (request, reply) => {
    const { created, ...result } = await hunger.create(
      request.user.id,
      request.body,
      request.ctx.locale,
    );
    reply.code(created ? 201 : 200);
    return result;
  });
  app.get('/', { ...read, schema: s.listSchema }, (request) =>
    hunger.list(request.user.id, request.query),
  );
  app.delete('/:id', { ...write, schema: s.deleteSchema }, (request) =>
    hunger.remove(request.user.id, request.params.id),
  );
}
