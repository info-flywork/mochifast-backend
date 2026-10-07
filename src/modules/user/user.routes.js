import { deprecatedRoute, memoizeByDeps } from '../../shared/legacy.js';
import { catalogServiceFor } from '../catalog/catalog.routes.js';
import { plansServiceFor } from '../plans/plans.routes.js';
import { createUserService } from './user.service.js';
import {
  getGoalsSchema,
  getMeSchema,
  getProfileSchema,
  getSettingsSchema,
  listConsentsSchema,
  onboardingSchema,
  patchGoalsSchema,
  patchMeSchema,
  patchProfileSchema,
  patchSettingsSchema,
  postConsentSchema,
  progressSchema,
} from './user.schemas.js';

const serviceFor = memoizeByDeps((app) =>
  createUserService({
    db: app.deps.db,
    catalog: catalogServiceFor(app),
    plans: plansServiceFor(app),
  }),
);

const meta = (request) => ({
  ip: request.ip,
  userAgent: request.headers['user-agent'],
  timezone: request.ctx.timezone,
});

/**
 * `/v1/user` uçları (docs/backend/04-api.md §2).
 * `{ legacy: true }` ile kaydedilince yalnızca eski istemcinin önek almayan yolları açılır.
 */
export default async function userRoutes(app, options) {
  const service = serviceFor(app);
  const auth = { preHandler: app.requireAuth };

  if (options.legacy) {
    app.get('/me', { ...auth, ...deprecatedRoute('/v1/user/me') }, (request) =>
      service.getMe(request.user.id),
    );
    app.get('/progress', { ...auth, ...deprecatedRoute('/v1/user/progress') }, (request) =>
      service.getProgress(request.user.id),
    );
    // Eski istemci seviye başına PATCH atıyordu; artık tek seferde POST /v1/user/onboarding. Yok sayılır.
    app.patch('/onboarding', deprecatedRoute('/v1/user/onboarding'), async () => ({}));
    return;
  }

  app.get('/me', { ...auth, schema: getMeSchema }, (request) => service.getMe(request.user.id));
  app.patch('/me', { ...auth, schema: patchMeSchema }, (request) =>
    service.updateMe(request.user.id, request.body),
  );

  app.post('/onboarding', { ...auth, schema: onboardingSchema }, (request) =>
    service.submitOnboarding(request.user.id, request.body, meta(request)),
  );

  app.get('/profile', { ...auth, schema: getProfileSchema }, (request) =>
    service.getProfile(request.user.id),
  );
  app.patch('/profile', { ...auth, schema: patchProfileSchema }, (request) =>
    service.updateProfile(request.user.id, request.body, meta(request)),
  );

  app.get('/settings', { ...auth, schema: getSettingsSchema }, (request) =>
    service.getSettings(request.user.id),
  );
  app.patch('/settings', { ...auth, schema: patchSettingsSchema }, (request) =>
    service.updateSettings(request.user.id, request.body),
  );

  app.get('/goals', { ...auth, schema: getGoalsSchema }, (request) =>
    service.getGoals(request.user.id),
  );
  app.patch('/goals', { ...auth, schema: patchGoalsSchema }, (request) =>
    service.updateGoals(request.user.id, request.body),
  );

  app.get('/consents', { ...auth, schema: listConsentsSchema }, (request) =>
    service.listConsents(request.user.id),
  );
  app.post('/consents', { ...auth, schema: postConsentSchema }, (request) =>
    service.addConsent(request.user.id, request.body, meta(request)),
  );

  app.get('/progress', { ...auth, schema: progressSchema }, (request) =>
    service.getProgress(request.user.id),
  );
}
