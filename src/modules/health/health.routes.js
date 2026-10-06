import { AppError } from '../../shared/errors.js';
import { envelope } from '../../shared/schemas.js';

const CHECK_TIMEOUT_MS = 1_000;

const checkSchema = {
  type: 'object',
  required: ['status', 'latencyMs'],
  properties: {
    status: { type: 'string', enum: ['up', 'down'] },
    latencyMs: { type: 'integer' },
  },
};

/**
 * Yük dengeleyici / orkestratör uçları. `/v1` öneki YOK, rate limit YOK.
 * - live : process ayakta mı (bağımlılık kontrolü yapmaz → gereksiz yeniden başlatma olmaz)
 * - ready: trafik alabilir mi (MySQL). Kapanışta 503 → LB trafiği keser.
 */
export default async function healthRoutes(app) {
  app.get(
    '/health/live',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['ops'],
        response: {
          200: envelope({
            type: 'object',
            required: ['status', 'uptimeSec'],
            properties: { status: { type: 'string' }, uptimeSec: { type: 'integer' } },
          }),
        },
      },
    },
    async () => ({ status: 'ok', uptimeSec: Math.floor(process.uptime()) }),
  );

  app.get(
    '/health/ready',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['ops'],
        response: {
          200: envelope({
            type: 'object',
            required: ['status', 'checks'],
            properties: {
              status: { type: 'string' },
              checks: { type: 'object', additionalProperties: checkSchema },
            },
          }),
        },
      },
    },
    async (request) => {
      if (app.isShuttingDown) {
        throw new AppError('UNAVAILABLE', { details: { reason: 'shutting_down' } });
      }
      const entries = await Promise.all([check('mysql', () => app.deps.db.ping())]);
      const checks = Object.fromEntries(
        entries.map(({ name, status, latencyMs }) => [name, { status, latencyMs }]),
      );
      const failed = entries.filter((e) => e.status === 'down');
      if (failed.length > 0) {
        request.log.warn(
          { failed: failed.map((f) => ({ name: f.name, error: f.error })) },
          'readiness başarısız',
        );
        throw new AppError('UNAVAILABLE', { details: { checks } });
      }
      return { status: 'ok', checks };
    },
  );
}

async function check(name, fn) {
  const started = performance.now();
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { name, status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      name,
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
