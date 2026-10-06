import Fastify, { LogController } from 'fastify';
import { API_PREFIX } from './config/constants.js';
import requestContext, { generateRequestId } from './plugins/request-context.js';
import security from './plugins/security.js';
import rateLimit from './plugins/rate-limit.js';
import envelope from './plugins/envelope.js';
import errors from './plugins/errors.js';
import docs from './plugins/docs.js';
import httpMetrics from './plugins/http-metrics.js';
import healthRoutes from './modules/health/health.routes.js';

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

  // Sıra önemli: bağlam → hata/zarf → güvenlik → rate limit → belgeler → metrik → route'lar
  await app.register(requestContext);
  await app.register(errors);
  await app.register(envelope);
  await app.register(security);
  await app.register(rateLimit);
  await app.register(docs);
  await app.register(httpMetrics);

  await app.register(healthRoutes);

  await app.register(
    async (v1) => {
      // Domain modülleri fazlarla burada kaydedilir (F1: auth, users, devices …).
      if (registerV1) await registerV1(v1);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
