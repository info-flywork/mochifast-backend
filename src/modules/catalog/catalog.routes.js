import { AppError } from '../../shared/errors.js';
import { setCatalogCacheHeaders } from '../../shared/http-cache.js';
import { memoizeByDeps } from '../../shared/legacy.js';
import { createCatalogService } from './catalog.service.js';
import { createContentService } from './content.service.js';
import {
  chatSuggestionsSchema,
  faqSchema,
  onboardingOptionsSchema,
  stagesSchema,
  struggleSchema,
} from './content.schemas.js';
import { planCatalogSchema, planDetailSchema } from './catalog.schemas.js';

export const catalogServiceFor = memoizeByDeps((app) =>
  createCatalogService({ db: app.deps.db, cache: app.deps.cache }),
);

export const contentServiceFor = memoizeByDeps((app) =>
  createContentService({ db: app.deps.db, cache: app.deps.cache, catalog: catalogServiceFor(app) }),
);

/** Katalog uçlarında token opsiyonel; geçersiz token hata değil, oturumsuz görünüm. */
export function softAuth(app) {
  return async (request) => {
    try {
      await app.optionalAuth(request);
    } catch {
      request.user = null;
    }
  };
}

/** Premium kilitleri: oturum varsa abonelikten (RevenueCat yansıması), yoksa ücretsiz görünüm. */
export const premiumOf = async (app, user) =>
  user ? app.deps.entitlements.isPremium(user.id) : false;

/**
 * `/v1/catalog` (docs/backend/04-api.md §4). Public; token varsa kilitler kişiselleşir.
 * Geçersiz token katalog için hata değildir: oturumsuz görünüm döner.
 */
export default async function catalogRoutes(app) {
  const service = catalogServiceFor(app);
  const content = contentServiceFor(app);
  const auth = softAuth(app);

  app.get('/plans', { schema: planCatalogSchema, preHandler: auth }, async (request, reply) => {
    setCatalogCacheHeaders(reply, { personal: Boolean(request.user) });
    return service.planCatalog(request.ctx.locale, {
      hasPremium: await premiumOf(app, request.user),
    });
  });

  app.get(
    '/plans/:code',
    { schema: planDetailSchema, preHandler: auth },
    async (request, reply) => {
      const detail = await service.planDetail(request.params.code, request.ctx.locale, {
        hasPremium: await premiumOf(app, request.user),
      });
      if (!detail) throw new AppError('NOT_FOUND');
      setCatalogCacheHeaders(reply, { personal: Boolean(request.user) });
      return detail;
    },
  );

  const publicCache = (reply) => setCatalogCacheHeaders(reply);

  app.get('/stages', { schema: stagesSchema }, async (request, reply) => {
    publicCache(reply);
    const type = request.query.type === 'body' ? 'body' : 'eating_window';
    return content.stages(type, request.ctx.locale);
  });

  app.get('/struggle', { schema: struggleSchema }, async (request, reply) => {
    publicCache(reply);
    return content.struggle(request.ctx.locale);
  });

  app.get('/faq', { schema: faqSchema }, async (request, reply) => {
    publicCache(reply);
    return content.faq(request.ctx.locale);
  });

  app.get('/chat-suggestions', { schema: chatSuggestionsSchema }, async (request, reply) => {
    publicCache(reply);
    return content.chatSuggestions(request.ctx.locale);
  });

  app.get(
    '/onboarding-options',
    { schema: onboardingOptionsSchema, preHandler: auth },
    async (request, reply) => {
      setCatalogCacheHeaders(reply, { personal: Boolean(request.user) });
      return content.onboardingOptions(request.ctx.locale, {
        hasPremium: await premiumOf(app, request.user),
      });
    },
  );
}
