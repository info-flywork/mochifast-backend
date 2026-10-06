import { PLATFORMS } from '../../config/constants.js';
import { compareVersions } from '../../shared/semver.js';
import { setCatalogCacheHeaders } from '../../shared/http-cache.js';
import { envelope } from '../../shared/schemas.js';
import { catalogServiceFor } from '../catalog/catalog.routes.js';

const appConfigSchema = {
  tags: ['app'],
  summary: 'Uygulama yapılandırması (min sürüm, özellikler, limitler, yasal metinler)',
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { platform: { type: 'string', enum: PLATFORMS } },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        platform: { type: ['string', 'null'] },
        minAppVersion: { type: ['string', 'null'] },
        latestAppVersion: { type: ['string', 'null'] },
        updateRequired: { type: 'boolean' },
        updateAvailable: { type: 'boolean' },
        features: { type: 'object', additionalProperties: { type: 'boolean' } },
        limits: { type: 'object', additionalProperties: { type: 'integer' } },
        marketing: { type: 'object', additionalProperties: true },
        legal: { type: 'object', additionalProperties: true },
        support: { type: 'object', additionalProperties: true },
        catalogVersion: { type: 'integer' },
      },
    }),
  },
};

/**
 * `GET /v1/app/config` (docs/backend/04-api.md §4). Platform: `?platform=` ya da `X-Platform`.
 * Sürümü eski uygulama da bu uca erişebilir (güncelleme ekranı için).
 */
export default async function appConfigRoutes(app) {
  const service = catalogServiceFor(app);

  app.get('/config', { schema: appConfigSchema }, async (request, reply) => {
    const platform = request.query.platform ?? request.ctx.platform ?? null;
    const cfg = await service.appConfig(platform);
    const min = cfg['app.min_version'] ?? null;
    const latest = cfg['app.latest_version'] ?? null;
    const current = request.ctx.appVersion;
    setCatalogCacheHeaders(reply, { vary: ['X-Platform', 'X-App-Version'] });
    return {
      platform,
      minAppVersion: platform ? min : null,
      latestAppVersion: platform ? latest : null,
      updateRequired: Boolean(platform && current && min && compareVersions(current, min) < 0),
      updateAvailable: Boolean(
        platform && current && latest && compareVersions(current, latest) < 0,
      ),
      features: cfg.features ?? {},
      limits: cfg.limits ?? {},
      marketing: cfg.marketing ?? {},
      legal: cfg.legal ?? {},
      support: cfg.support ?? {},
      catalogVersion: cfg['catalog.version'] ?? 0,
    };
  });
}
