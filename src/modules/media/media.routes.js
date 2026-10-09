import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { AppError } from '../../shared/errors.js';
import { memoizeByDeps } from '../../shared/legacy.js';
import { createMediaService } from './media.service.js';
import * as s from './media.schemas.js';

export const mediaServiceFor = memoizeByDeps((app) =>
  createMediaService({
    db: app.deps.db,
    storage: app.deps.storage,
    config: app.config.media,
    logger: app.log,
  }),
);

/** Yüklemeler pahalıdır (sharp): IP rate limit'inin üstüne kullanıcı başına sınır. */
export const uploadRateLimit = { rateLimit: { max: 30, timeWindow: '1 hour' } };

/** Tek dosyalı multipart gövdesini belleğe alır (sınırlar @fastify/multipart'ta). */
export async function readUpload(request) {
  if (!request.isMultipart()) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', { details: { expected: 'multipart/form-data' } });
  }
  const file = await request.file();
  if (!file) {
    throw new AppError('VALIDATION_FAILED', {
      details: { fields: [{ path: 'file', message: 'is required' }] },
    });
  }
  return file.toBuffer();
}

/** `/v1/media` (docs/backend/04-api.md, 08-medya-bunny.md). */
export default async function mediaRoutes(app) {
  const media = mediaServiceFor(app);
  const auth = { preHandler: app.requireAuth };

  app.post(
    '/',
    { ...auth, schema: s.uploadSchema, config: uploadRateLimit },
    async (request, reply) => {
      const buffer = await readUpload(request);
      const result = await media.upload(request.user.id, 'meal_photo', buffer);
      reply.code(result.duplicate ? 200 : 201);
      return { media: media.present(result.media) };
    },
  );
  app.get('/:id', { ...auth, schema: s.getSchema }, (request) =>
    media.get(request.user.id, request.params.id),
  );
  app.delete('/:id', { ...auth, schema: s.deleteSchema }, (request) =>
    media.remove(request.user.id, request.params.id),
  );
}

/**
 * Yalnızca `MEDIA_DRIVER=local` (geliştirme/test): Bunny edge'inin yerine dosyaları sunar.
 * Private dosyalar Bunny ile aynı token kontrolünden geçer; token yok/süresi geçmiş → 403.
 */
export async function localMediaFiles(app) {
  const { storage } = app.deps;
  const serve = (zone, checkToken) => async (request, reply) => {
    const path = request.params['*'];
    if (
      checkToken &&
      !storage.verifyPrivateToken(path, request.query.token, request.query.expires)
    ) {
      throw new AppError('FORBIDDEN');
    }
    let file;
    try {
      file = zone.full(path);
      await stat(file);
    } catch {
      throw new AppError('NOT_FOUND');
    }
    reply
      .header('content-type', 'image/webp')
      .header('cache-control', checkToken ? 'private, max-age=3600' : 'public, max-age=86400');
    return reply.send(createReadStream(file));
  };
  app.get('/media-files/*', serve(storage.private, true));
  app.get('/media-public/*', serve(storage.public, false));
}
