import { memoizeByDeps } from '../../shared/legacy.js';
import { createAuthService } from './auth.service.js';
import {
  guestSchema,
  listSessionsSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  revokeSessionSchema,
} from './auth.schemas.js';

/** POST /auth/* için IP başına sınır (docs/backend/06-guvenlik.md §7). */
const AUTH_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };

// /v1 ve eski yol aynı servisi (aynı refresh grace belleği ve installId sayaçları) kullanır.
const serviceFor = memoizeByDeps((app) =>
  createAuthService({ ...app.deps, config: app.config, logger: app.log }),
);

/**
 * `/v1/auth` uçları (docs/backend/04-api.md §1).
 */
export default async function authRoutes(app) {
  const service = serviceFor(app);

  const meta = (request) => ({
    ip: request.ip,
    userAgent: request.headers['user-agent'],
    locale: request.ctx.locale,
    timezone: request.ctx.timezone,
    platform: request.ctx.platform,
    appVersion: request.ctx.appVersion,
  });

  const register = async (request, reply) => {
    const result = await service.register(request.body, meta(request), request.user);
    reply.code(result.outcome === 'created' ? 201 : 200);
    return {
      token: result.token,
      user: result.user,
      isNewUser: result.outcome === 'created',
      linkedFromGuest: result.outcome === 'upgraded',
      mergedFromGuest: result.outcome === 'merged',
    };
  };
  const registerOptions = {
    schema: registerSchema,
    preHandler: app.optionalAuth,
    config: { rateLimit: AUTH_RATE_LIMIT },
  };
  app.post(
    '/guest',
    { schema: guestSchema, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const result = await service.guest(request.body, meta(request));
      reply.code(result.created ? 201 : 200);
      return { token: result.token, user: result.user };
    },
  );

  app.post('/register', registerOptions, register);
  app.post('/social', { ...registerOptions, schema: { ...registerSchema, hide: true } }, register);
  app.post(
    '/firebase',
    { ...registerOptions, schema: { ...registerSchema, hide: true } },
    register,
  );

  app.post(
    '/refresh',
    { schema: refreshSchema, config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request) => ({ token: await service.refresh(request.body.refreshToken, meta(request)) }),
  );

  app.post('/logout', { schema: logoutSchema, preHandler: app.requireAuth }, async (request) => {
    await service.logout(request.user, request.body ?? {}, meta(request));
    return {};
  });

  app.get(
    '/sessions',
    { schema: listSessionsSchema, preHandler: app.requireAuth },
    async (request) => ({
      items: await service.listSessions(request.user),
      pageInfo: { nextCursor: null, hasMore: false },
    }),
  );

  app.delete(
    '/sessions/:id',
    { schema: revokeSessionSchema, preHandler: app.requireAuth },
    async (request) => {
      await service.revokeSession(request.user, request.params.id, meta(request));
      return {};
    },
  );
}
