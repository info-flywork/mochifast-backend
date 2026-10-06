import { setCatalogCacheHeaders } from '../../shared/http-cache.js';
import { contentServiceFor, hasPremium, softAuth } from './catalog.routes.js';
import {
  insightArticleSchema,
  insightArticlesSchema,
  insightCategoriesSchema,
} from './content.schemas.js';

/**
 * `/v1/insights` (docs/backend/04-api.md). Public; token varsa premium kilidi kişiselleşir.
 */
export default async function insightsRoutes(app) {
  const content = contentServiceFor(app);
  const auth = softAuth(app);
  const cacheHeaders = (request, reply) =>
    setCatalogCacheHeaders(reply, { personal: Boolean(request.user) });
  const premium = (request) => ({ hasPremium: hasPremium(request.user) });

  app.get(
    '/categories',
    { schema: insightCategoriesSchema, preHandler: auth },
    async (request, reply) => {
      cacheHeaders(request, reply);
      return content.insightCategories(request.ctx.locale, premium(request));
    },
  );

  app.get(
    '/articles',
    { schema: insightArticlesSchema, preHandler: auth },
    async (request, reply) => {
      cacheHeaders(request, reply);
      return content.insightArticles(request.ctx.locale, request.query, premium(request));
    },
  );

  app.get(
    '/articles/:slug',
    { schema: insightArticleSchema, preHandler: auth },
    async (request, reply) => {
      const article = await content.insightArticle(
        request.params.slug,
        request.ctx.locale,
        premium(request),
      );
      cacheHeaders(request, reply);
      return article;
    },
  );
}
