import { memoizeByDeps } from '../../shared/legacy.js';
import { trackerContextFor } from '../trackers/trackers.routes.js';
import { createMealsService } from './meals.service.js';
import * as s from './meals.schemas.js';

export const mealsServiceFor = memoizeByDeps((app) =>
  createMealsService({ db: app.deps.db, crypto: app.deps.crypto, ctx: trackerContextFor(app) }),
);

/** `/v1/meals` (docs/backend/04-api.md §11). */
export async function mealsRoutes(app) {
  const meals = mealsServiceFor(app);
  const read = { preHandler: app.requireAuth };
  const write = { preHandler: [app.requireAuth, app.idempotent] };

  app.post('/', { ...write, schema: s.mealCreateSchema }, async (request, reply) => {
    const { created, ...result } = await meals.create(request.user.id, request.body ?? {});
    reply.code(created ? 201 : 200);
    return result;
  });
  app.get('/', { ...read, schema: s.mealListSchema }, (request) =>
    meals.list(request.user.id, request.query),
  );
  app.get('/:id', { ...read, schema: s.mealGetSchema }, (request) =>
    meals.get(request.user.id, request.params.id),
  );
  app.patch('/:id', { ...write, schema: s.mealUpdateSchema }, (request) =>
    meals.update(request.user.id, request.params.id, request.body),
  );
  app.delete('/:id', { ...write, schema: s.mealDeleteSchema }, (request) =>
    meals.remove(request.user.id, request.params.id),
  );
}

/** `/v1/nutrition` (04-api §11). */
export async function nutritionRoutes(app) {
  const meals = mealsServiceFor(app);
  const read = { preHandler: app.requireAuth };
  app.get('/day', { ...read, schema: s.nutritionDaySchema }, (request) =>
    meals.day(request.user.id, request.query.date),
  );
  app.get('/week', { ...read, schema: s.nutritionWeekSchema }, (request) =>
    meals.week(request.user.id, request.query),
  );
}
