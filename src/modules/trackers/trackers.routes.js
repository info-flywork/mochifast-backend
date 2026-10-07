import { memoizeByDeps } from '../../shared/legacy.js';
import { statsServiceFor } from '../stats/stats.routes.js';
import { userServiceFor } from '../user/user.routes.js';
import { createTrackerContext } from './context.js';
import { createSleepService } from './sleep.service.js';
import { createStepsService } from './steps.service.js';
import * as s from './trackers.schemas.js';
import { createWaterService } from './water.service.js';
import { createWeightsService } from './weights.service.js';

export const trackerContextFor = memoizeByDeps((app) =>
  createTrackerContext({ db: app.deps.db, stats: statsServiceFor(app) }),
);

export const trackersFor = memoizeByDeps((app) => {
  const deps = { db: app.deps.db, ctx: trackerContextFor(app) };
  return {
    weights: createWeightsService({ ...deps, users: userServiceFor(app) }),
    water: createWaterService(deps),
    steps: createStepsService(deps),
    sleep: createSleepService(deps),
  };
});

const meta = (r) => ({ ip: r.ip, userAgent: r.headers['user-agent'], timezone: r.ctx.timezone });

/** `/v1/weights` (docs/backend/04-api.md §7). */
export async function weightsRoutes(app) {
  const { weights } = trackersFor(app);
  const read = { preHandler: app.requireAuth };
  const write = { preHandler: [app.requireAuth, app.requireHealthConsent, app.idempotent] };

  app.post('/', { ...write, schema: s.weightCreateSchema }, async (request, reply) => {
    const result = await weights.create(request.user.id, request.body);
    reply.code(result.created ? 201 : 200);
    return { entry: result.entry };
  });
  app.get('/', { ...read, schema: s.weightListSchema }, (request) =>
    weights.list(request.user.id, request.query),
  );
  // Sabit yollar `/:id`'den önce.
  app.get('/chart', { ...read, schema: s.weightChartSchema }, (request) =>
    weights.chart(request.user.id, request.query.range, request.ctx.locale),
  );
  app.get('/summary', { ...read, schema: s.weightSummarySchema }, (request) =>
    weights.summary(request.user.id),
  );
  app.patch('/goal', { ...write, schema: s.weightGoalSchema }, (request) =>
    weights.setGoal(request.user.id, request.body.goalWeightKg, meta(request)),
  );
  app.patch('/:id', { ...write, schema: s.weightUpdateSchema }, (request) =>
    weights.update(request.user.id, request.params.id, request.body),
  );
  app.delete('/:id', { ...write, schema: s.weightDeleteSchema }, (request) =>
    weights.remove(request.user.id, request.params.id),
  );
}

/** `/v1/water` (04-api §8). */
export async function waterRoutes(app) {
  const { water } = trackersFor(app);
  const read = { preHandler: app.requireAuth };
  const write = { preHandler: [app.requireAuth, app.requireHealthConsent, app.idempotent] };

  app.get('/day', { ...read, schema: s.waterDaySchema }, (request) =>
    water.day(request.user.id, request.query.date),
  );
  app.get('/week', { ...read, schema: s.waterWeekSchema }, (request) =>
    water.week(request.user.id, request.query.date),
  );
  app.post('/', { ...write, schema: s.waterAddSchema }, async (request, reply) => {
    const result = await water.add(request.user.id, request.body);
    reply.code(result.created ? 201 : 200);
    return result.day;
  });
  app.delete('/:id', { ...write, schema: s.waterDeleteSchema }, (request) =>
    water.remove(request.user.id, request.params.id),
  );
}

/** `/v1/steps` (04-api §9). */
export async function stepsRoutes(app) {
  const { steps } = trackersFor(app);
  const read = { preHandler: app.requireAuth };
  const write = { preHandler: [app.requireAuth, app.requireHealthConsent, app.idempotent] };

  app.get('/', { ...read, schema: s.stepsListSchema }, (request) =>
    steps.list(request.user.id, request.query),
  );
  app.post('/sync', { ...write, schema: s.stepsSyncSchema }, (request) =>
    steps.sync(request.user.id, request.body),
  );
  app.put('/:date', { ...write, schema: s.stepsPutSchema }, (request) =>
    steps.put(request.user.id, request.params.date, request.body),
  );
}

/** `/v1/sleep` (04-api §10). */
export async function sleepRoutes(app) {
  const { sleep } = trackersFor(app);
  const read = { preHandler: app.requireAuth };
  const write = { preHandler: [app.requireAuth, app.requireHealthConsent, app.idempotent] };

  app.post('/', { ...write, schema: s.sleepCreateSchema }, async (request, reply) => {
    const result = await sleep.create(request.user.id, request.body);
    reply.code(result.created ? 201 : 200);
    return { entry: result.entry };
  });
  app.get('/summary', { ...read, schema: s.sleepSummarySchema }, (request) =>
    sleep.summary(request.user.id, request.query.date),
  );
  app.post('/sync', { ...write, schema: s.sleepSyncSchema }, (request) =>
    sleep.sync(request.user.id, request.body),
  );
  app.patch('/:id', { ...write, schema: s.sleepUpdateSchema }, (request) =>
    sleep.update(request.user.id, request.params.id, request.body),
  );
  app.delete('/:id', { ...write, schema: s.sleepDeleteSchema }, (request) =>
    sleep.remove(request.user.id, request.params.id),
  );
}
