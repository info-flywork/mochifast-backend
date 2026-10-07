import Fastify, { LogController } from 'fastify';
import { API_PREFIX } from './config/constants.js';
import requestContext, { generateRequestId } from './plugins/request-context.js';
import security from './plugins/security.js';
import rateLimit from './plugins/rate-limit.js';
import auth from './plugins/auth.js';
import appVersion from './plugins/app-version.js';
import idempotency from './plugins/idempotency.js';
import envelope from './plugins/envelope.js';
import errors from './plugins/errors.js';
import docs from './plugins/docs.js';
import httpMetrics from './plugins/http-metrics.js';
import healthRoutes from './modules/health/health.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/user/user.routes.js';
import devicesRoutes from './modules/devices/devices.routes.js';
import catalogRoutes from './modules/catalog/catalog.routes.js';
import insightsRoutes from './modules/catalog/insights.routes.js';
import plansRoutes from './modules/plans/plans.routes.js';
import fastingRoutes, { strugglesRoutes } from './modules/fasting/fasting.routes.js';
import appConfigRoutes from './modules/app/app-config.routes.js';
import hungerRoutes from './modules/hunger/hunger.routes.js';
import { mealsRoutes, nutritionRoutes } from './modules/meals/meals.routes.js';
import {
  sleepRoutes,
  stepsRoutes,
  waterRoutes,
  weightsRoutes,
} from './modules/trackers/trackers.routes.js';

/**
 * Fastify uygulamasını kurar. Altyapıya bağlanmaz: bağımlılıklar (`deps`) dışarıdan verilir,
 * böylece aynı fonksiyon sunucu, testler ve OpenAPI üretimi tarafından kullanılır.
 *
 * @param options.logger Fastify'ın kullanacağı pino; testlerde false
 * @param [options.registerV1] ek /v1 route'ları (testler)
 */
export async function buildApp({ config, deps, logger, registerV1 }) {
  const app = Fastify({
    ...(logger ? { loggerInstance: logger } : { logger: false }),
    genReqId: generateRequestId,
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      // LB sağlık yoklamaları birkaç saniyede bir gelir; istek loglarını boğmasın.
      disableRequestLogging: (request) => request.url.startsWith('/health/'),
    }),
    // Fastify çalışma zamanında hop sayısını (number) da kabul eder; tip tanımı eksik.
    trustProxy: config.server.trustProxy,
    bodyLimit: config.server.bodyLimit,
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: true },
    ajv: {
      customOptions: {
        removeAdditional: false, // bilinmeyen alan → 400 (şemalarda additionalProperties:false)
        coerceTypes: 'array', // yalnızca querystring/params'ta anlamlı
        useDefaults: true,
        allErrors: false,
      },
    },
  });

  app.decorate('config', config);
  app.decorate('deps', deps);
  app.decorate('isShuttingDown', false);

  // Sıra önemli: bağlam → hata/zarf → güvenlik → rate limit → auth → belgeler → metrik → route'lar
  await app.register(requestContext);
  await app.register(errors);
  await app.register(envelope);
  await app.register(security);
  await app.register(rateLimit);
  await app.register(auth);
  await app.register(appVersion);
  await app.register(idempotency);
  await app.register(docs);
  await app.register(httpMetrics);

  await app.register(healthRoutes);

  // Eski istemci yolları (önek yok) → aynı handler + Deprecation header'ı (docs/backend/12 F1).
  await app.register(authRoutes, { prefix: '/auth', legacy: true });
  await app.register(userRoutes, { prefix: '/user', legacy: true });

  await app.register(
    async (v1) => {
      // Domain modülleri fazlarla burada kaydedilir.
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(userRoutes, { prefix: '/user' });
      await v1.register(devicesRoutes, { prefix: '/devices' });
      await v1.register(catalogRoutes, { prefix: '/catalog' });
      await v1.register(insightsRoutes, { prefix: '/insights' });
      await v1.register(plansRoutes, { prefix: '/plans' });
      await v1.register(fastingRoutes, { prefix: '/fasts' });
      await v1.register(strugglesRoutes, { prefix: '/struggles' });
      await v1.register(appConfigRoutes, { prefix: '/app' });
      await v1.register(weightsRoutes, { prefix: '/weights' });
      await v1.register(waterRoutes, { prefix: '/water' });
      await v1.register(stepsRoutes, { prefix: '/steps' });
      await v1.register(sleepRoutes, { prefix: '/sleep' });
      await v1.register(mealsRoutes, { prefix: '/meals' });
      await v1.register(nutritionRoutes, { prefix: '/nutrition' });
      await v1.register(hungerRoutes, { prefix: '/hunger-checkins' });
      if (registerV1) await registerV1(v1);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
