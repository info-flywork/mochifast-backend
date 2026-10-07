import { memoizeByDeps } from '../../shared/legacy.js';
import { contentServiceFor } from '../catalog/catalog.routes.js';
import { plansServiceFor } from '../plans/plans.routes.js';
import { statsServiceFor } from '../stats/stats.routes.js';
import { createFastingService } from './fasting.service.js';
import { createDailyTipService } from './daily-tip.js';
import { createForecastService } from './forecast.js';
import {
  activeSchema,
  cancelSchema,
  dailyTipSchema,
  finishSchema,
  forecastSchema,
  getSchema,
  listSchema,
  manualSchema,
  removeSchema,
  startSchema,
  struggleSchema,
  struggleWithFastSchema,
  statsSchema,
  updateSchema,
  weekSchema,
} from './fasting.schemas.js';

export const fastingServiceFor = memoizeByDeps((app) =>
  createFastingService({
    db: app.deps.db,
    crypto: app.deps.crypto,
    plans: plansServiceFor(app),
    content: contentServiceFor(app),
    stats: statsServiceFor(app),
  }),
);

export const forecastServiceFor = memoizeByDeps((app) =>
  createForecastService({ db: app.deps.db }),
);
const dailyTipFor = memoizeByDeps((app) => createDailyTipService({ db: app.deps.db }));

/**
 * `/v1/fasts` (docs/backend/04-api.md §6). Yazma uçları Idempotency-Key destekler.
 */
export default async function fastingRoutes(app) {
  const service = fastingServiceFor(app);
  const stats = statsServiceFor(app);
  const forecast = forecastServiceFor(app);
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

  // `/:id`'den önce: sabit yollar parametreli yolla karışmasın.
  app.get('/daily-tip', { ...read, schema: dailyTipSchema }, (request) =>
    dailyTipFor(app).dailyTip(
      request.user.id,
      request.headers['accept-language'] ? request.ctx.locale : null,
    ),
  );
  app.get('/forecast', { ...read, schema: forecastSchema }, (request) =>
    forecast.forecast(request.user.id),
  );
  app.get('/week', { ...read, schema: weekSchema }, (request) =>
    stats.week(request.user.id, { date: request.query.date }),
  );

  app.get('/stats', { ...read, schema: statsSchema }, (request) =>
    stats.rangeStats(request.user.id, request.query.range),
  );

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
