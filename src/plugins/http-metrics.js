import fp from 'fastify-plugin';

/**
 * Route bazında HTTP süre histogramı. Etiket olarak ham URL değil route şablonu kullanılır
 * (`/v1/fasts/:id`) — aksi hâlde metrik kardinalitesi patlar.
 */
export default fp(
  async function httpMetrics(app) {
    const metrics = app.deps.metrics;
    if (!metrics) return;
    app.addHook('onResponse', async (request, reply) => {
      metrics.httpDuration.observe(
        {
          method: request.method,
          route: request.routeOptions.url ?? 'not_found',
          status_code: String(reply.statusCode),
        },
        reply.elapsedTime / 1000,
      );
    });
  },
  { name: 'http-metrics' },
);
