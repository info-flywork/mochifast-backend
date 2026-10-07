import { deprecatedRoute, memoizeByDeps } from '../../shared/legacy.js';
import { catalogServiceFor } from '../catalog/catalog.routes.js';
import { fastingServiceFor } from '../fasting/fasting.routes.js';
import { challengesServiceFor } from '../gamification/gamification.routes.js';
import { mediaServiceFor, readUpload, uploadRateLimit } from '../media/media.routes.js';
import { avatarDeleteSchema, avatarPutSchema } from '../media/media.schemas.js';
import { plansServiceFor } from '../plans/plans.routes.js';
import { statsServiceFor } from '../stats/stats.routes.js';
import { createSummaryService } from './summary.service.js';
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
  summarySchema,
  userStatsSchema,
} from './user.schemas.js';

export const userServiceFor = memoizeByDeps((app) =>
  createUserService({
    db: app.deps.db,
    catalog: catalogServiceFor(app),
    plans: plansServiceFor(app),
    stats: statsServiceFor(app),
    media: mediaServiceFor(app),
    entitlements: app.deps.entitlements,
  }),
);

const summaryFor = memoizeByDeps((app) =>
  createSummaryService({
    db: app.deps.db,
    users: userServiceFor(app),
    plans: plansServiceFor(app),
    fasting: fastingServiceFor(app),
    stats: statsServiceFor(app),
    challenges: challengesServiceFor(app),
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
  const service = userServiceFor(app);
  const stats = statsServiceFor(app);
  const auth = { preHandler: app.requireAuth };

  if (options.legacy) {
    app.get('/me', { ...auth, ...deprecatedRoute('/v1/user/me') }, (request) =>
      service.getMe(request.user.id),
    );
    app.get('/progress', { ...auth, ...deprecatedRoute('/v1/user/progress') }, (request) =>
      stats.progress(request.user.id),
    );
    // Eski istemci seviye başına PATCH atıyordu; artık tek seferde POST /v1/user/onboarding. Yok sayılır.
    app.patch('/onboarding', deprecatedRoute('/v1/user/onboarding'), async () => ({}));
    return;
  }

  app.get('/me', { ...auth, schema: getMeSchema }, (request) => service.getMe(request.user.id));
  // Avatar senkron yüklenir; eski avatar hemen silinir (docs/backend/08-medya-bunny.md §6).
  app.put(
    '/me/avatar',
    { ...auth, schema: avatarPutSchema, config: uploadRateLimit },
    async (request) => mediaServiceFor(app).setAvatar(request.user.id, await readUpload(request)),
  );
  app.delete('/me/avatar', { ...auth, schema: avatarDeleteSchema }, (request) =>
    mediaServiceFor(app).removeAvatar(request.user.id),
  );
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
    stats.progress(request.user.id),
  );
  app.get('/stats', { ...auth, schema: userStatsSchema }, (request) =>
    stats.userStats(request.user.id, request.query.range),
  );
  app.get('/summary', { ...auth, schema: summarySchema }, (request) =>
    summaryFor(app).summary(request.user.id, request.ctx.locale),
  );
}
