import { memoizeByDeps } from '../../shared/legacy.js';
import { catalogServiceFor } from '../catalog/catalog.routes.js';
import { mediaServiceFor, readUpload, uploadRateLimit } from '../media/media.routes.js';
import { createAiGate } from './ai.gate.js';
import { createPhotoAnalysisService } from './photo-analysis.service.js';
import * as s from './ai.schemas.js';

export const aiGateFor = memoizeByDeps((app) =>
  createAiGate({ db: app.deps.db, catalog: catalogServiceFor(app), cache: app.deps.cache }),
);

export const photoAnalysisFor = memoizeByDeps((app) =>
  createPhotoAnalysisService({
    db: app.deps.db,
    jobs: app.deps.jobs,
    gate: aiGateFor(app),
    media: mediaServiceFor(app),
    ai: app.deps.ai,
    storage: app.deps.storage,
    config: app.config.ai,
    logger: app.log,
  }),
);

/** `/v1/meals/photo-analyses` (docs/backend/04-api.md §11). meals route'larına eklenir. */
export async function photoAnalysisRoutes(app) {
  const analyses = photoAnalysisFor(app);
  const auth = { preHandler: app.requireAuth };
  app.post(
    '/photo-analyses',
    { ...auth, schema: s.submitSchema, config: uploadRateLimit },
    async (request, reply) => {
      const buffer = await readUpload(request);
      reply.code(202);
      return analyses.submit(request.user.id, buffer, request.ctx.locale);
    },
  );
  app.get('/photo-analyses/:id', { ...auth, schema: s.getAnalysisSchema }, (request) =>
    analyses.get(request.user.id, request.params.id),
  );
}

/** `/v1/chat` — F6 1. hafta: yalnızca kota; sohbet uçları 2. haftada. */
export default async function chatRoutes(app) {
  const gate = aiGateFor(app);
  app.get('/quota', { preHandler: app.requireAuth, schema: s.quotaSchema }, (request) =>
    gate.status(request.user.id),
  );
}
