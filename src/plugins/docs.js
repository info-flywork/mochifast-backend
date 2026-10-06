import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { errorEnvelope } from '../shared/schemas.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/**
 * OpenAPI: route şemalarından otomatik üretilir (her zaman açık; `npm run openapi` kullanır).
 * Swagger UI yalnızca DOCS_ENABLED=true iken ve basic auth arkasında (dev/staging).
 */
export default fp(
  async function docs(app) {
    const { config } = app;

    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'MochiFast API',
          version: pkg.version,
          description:
            'Yanıt zarfı: { status, message, data } — hata: { status:"error", message, error:{ code, details, requestId } }',
        },
        servers: config.server.publicBaseUrl ? [{ url: config.server.publicBaseUrl }] : [],
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
          schemas: { ErrorEnvelope: errorEnvelope },
        },
      },
    });

    if (!config.docs.enabled) return;

    await app.register(async (scope) => {
      scope.addHook('onRequest', async (request, reply) => {
        if (!isAuthorized(request.headers.authorization, config.docs.user, config.docs.password)) {
          reply.header('www-authenticate', 'Basic realm="MochiFast API docs"');
          return reply.code(401).send('Unauthorized');
        }
      });
      await scope.register(swaggerUi, { routePrefix: '/docs' });
    });
  },
  { name: 'docs' },
);

function isAuthorized(header, user, password) {
  if (!header?.startsWith('Basic ')) return false;
  const given = Buffer.from(header.slice(6), 'base64');
  const expected = Buffer.from(`${user}:${password}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
