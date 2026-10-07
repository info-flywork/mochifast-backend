import { memoizeByDeps } from '../../shared/legacy.js';
import { statsServiceFor } from '../stats/stats.routes.js';
import { createChallengesService } from './challenges.service.js';
import * as s from './gamification.schemas.js';
import { createWorldService } from './world.service.js';

export const challengesServiceFor = memoizeByDeps((app) =>
  createChallengesService({ db: app.deps.db }),
);
const worldServiceFor = memoizeByDeps((app) =>
  createWorldService({ db: app.deps.db, stats: statsServiceFor(app) }),
);

/** `/v1/world` (docs/backend/04-api.md §13). */
export async function worldRoutes(app) {
  const world = worldServiceFor(app);
  app.get('/', { preHandler: app.requireAuth, schema: s.worldSchema }, (request) =>
    world.get(request.user.id),
  );
}

/** `/v1/challenges` */
export async function challengesRoutes(app) {
  const challenges = challengesServiceFor(app);
  const auth = { preHandler: app.requireAuth };
  app.get('/', { ...auth, schema: s.listChallengesSchema }, (request) =>
    challenges.list(request.user.id, request.ctx.locale),
  );
  app.get('/featured', { ...auth, schema: s.featuredSchema }, (request) =>
    challenges.featured(request.user.id, request.ctx.locale),
  );
  app.post('/:code/join', { ...auth, schema: s.joinSchema }, (request) =>
    challenges.join(request.user.id, request.params.code, request.ctx.locale),
  );
  app.post('/:code/leave', { ...auth, schema: s.leaveSchema }, (request) =>
    challenges.leave(request.user.id, request.params.code, request.ctx.locale),
  );
}
