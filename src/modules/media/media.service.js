import { AppError } from '../../shared/errors.js';
import { newId, toBin } from '../../shared/ids.js';
import * as repo from './media.repository.js';
import { PURPOSES, ownerKey, processImage, storagePrefix } from './media.pipeline.js';

/**
 * Medya: yükleme, imzalı URL ile sunma ve silme (docs/backend/08-medya-bunny.md).
 * Öğün fotoğrafları private zone + imzalı URL; avatar public zone (kalıcı URL).
 */
export function createMediaService({ db, storage, config, logger }) {
  const zoneOf = (m) => (m.visibility === 'public' ? storage.public : storage.private);

  /** Yanıtlara gömülen biçim. İstemci cache anahtarı: `${id}_${variant}` (token değişse de). */
  function present(m) {
    if (!m || m.status !== 'ready') return null;
    const spec = PURPOSES[m.purpose];
    const urls = {};
    let expiresAt = null;
    for (const [name, path] of Object.entries(m.variants)) {
      if (m.visibility === 'public') {
        urls[name] = storage.publicUrl(path);
      } else {
        const signed = storage.signPrivateUrl(path);
        urls[name] = signed.url;
        expiresAt = signed.expiresAt;
      }
    }
    return {
      id: m.id,
      url: urls[spec?.main ?? 'md'] ?? Object.values(urls)[0] ?? null,
      thumbUrl: urls.thumb ?? null,
      variants: urls,
      width: m.width,
      height: m.height,
      blurhash: m.blurhash,
      expiresAt,
    };
  }

  /** Dosyaları siler, cache'i temizler, kaydı `deleted` yapar. Hata bir sonraki temizliğe kalır. */
  async function destroy(m) {
    const zone = zoneOf(m);
    await Promise.all(Object.values(m.variants).map((path) => zone.delete(path)));
    await Promise.all(
      Object.values(m.variants).map((path) =>
        zone.purge(path).catch((err) => logger?.warn({ err, path }, 'purge başarısız')),
      ),
    );
    await repo.setStatus(db, m.id, 'deleted');
  }

  const service = {
    present,
    destroy,

    /**
     * Yükle → işle → varyantları paralel yaz → `ready`. Aynı içerik 24 saat içinde tekrar
     * gelirse mevcut kayıt döner.
     */
    async upload(userId, purpose, buffer) {
      const processed = await processImage(buffer, purpose);
      // userId null: yönetici içeriği (public; sahibi yok, yineleme kontrolü yapılmaz).
      if (userId) {
        const duplicate = await repo.findDuplicate(db, userId, purpose, processed.sha256);
        if (duplicate) return { media: duplicate, duplicate: true };
      }

      const id = newId();
      const prefix = storagePrefix(purpose, {
        ownerKey: userId ? ownerKey(userId, config.pathSecret) : null,
        mediaId: id,
      });
      const sizes = PURPOSES[purpose].variants;
      const paths = Object.fromEntries(
        Object.keys(processed.variants).map((name) => [name, `${prefix}_${sizes[name]}.webp`]),
      );
      const record = {
        id,
        ownerUserId: userId,
        purpose,
        visibility: PURPOSES[purpose].visibility,
        storagePath: prefix,
        variants: paths,
        bytes: Object.values(processed.variants).reduce((sum, v) => sum + v.bytes, 0),
        width: processed.width,
        height: processed.height,
        blurhash: processed.blurhash,
        sha256: processed.sha256,
      };
      await repo.insertMedia(db, record);

      const zone = zoneOf(record);
      try {
        await Promise.all(
          Object.entries(processed.variants).map(([name, v]) =>
            zone.put(paths[name], v.buffer, 'image/webp'),
          ),
        );
      } catch (err) {
        await repo.setStatus(db, id, 'failed');
        // Yarım kalan varyantlar silinir; silinemeyenleri takılı kayıt temizliği toplar.
        await Promise.allSettled(Object.values(paths).map((p) => zone.delete(p)));
        throw new AppError('UNAVAILABLE', { cause: err, details: { reason: 'storage' } });
      }
      await repo.setStatus(db, id, 'ready');
      return { media: { ...record, status: 'ready' }, duplicate: false };
    },

    /** Kullanıcının kendi, hazır medyası; değilse 404 (başkasının varlığı sızdırılmaz). */
    async mustOwn(userId, id, { purpose } = {}) {
      const m = await repo.findMedia(db, id);
      if (!m || m.ownerUserId !== userId || m.status !== 'ready') throw new AppError('NOT_FOUND');
      if (purpose && m.purpose !== purpose) {
        throw new AppError('VALIDATION_FAILED', {
          details: { fields: [{ path: 'photoMediaId', message: `must be a ${purpose} upload` }] },
        });
      }
      return m;
    },

    /** id → sunulmuş medya (hazır olmayanlar null). */
    async presentMany(ids) {
      const unique = [...new Set(ids.filter(Boolean))];
      const found = await repo.findMany(db, unique);
      return new Map(unique.map((id) => [id, present(found.get(id))]));
    },

    async get(userId, id) {
      return { media: present(await service.mustOwn(userId, id)) };
    },

    /** Silme: öğünlerden bağlantı kalkar (FK yerine açıkça), dosyalar silinir. */
    async remove(userId, id) {
      const m = await service.mustOwn(userId, id);
      await db.run('UPDATE meals SET photo_media_id = NULL WHERE photo_media_id = :id', {
        id: toBin(id),
      });
      await db.run('UPDATE users SET avatar_media_id = NULL WHERE avatar_media_id = :id', {
        id: toBin(id),
      });
      await destroy(m);
      return {};
    },

    /** PUT /v1/user/me/avatar — senkron; eski avatar hemen silinir. */
    async setAvatar(userId, buffer) {
      const { media } = await service.upload(userId, 'avatar', buffer);
      const previous = await db.withTransaction(async (conn) => {
        const old = await repo.avatarOf(db, userId, conn);
        await repo.setAvatar(db, conn, userId, media.id);
        return old;
      });
      if (previous && previous.id !== media.id) {
        await destroy(previous).catch((err) =>
          logger?.warn({ err, mediaId: previous.id }, 'eski avatar silinemedi'),
        );
      }
      return { avatar: present(media) };
    },

    async removeAvatar(userId) {
      const previous = await db.withTransaction(async (conn) => {
        const old = await repo.avatarOf(db, userId, conn);
        await repo.setAvatar(db, conn, userId, null);
        return old;
      });
      if (previous) await destroy(previous);
      return {};
    },

    async avatarUrl(userId) {
      return present(await repo.avatarOf(db, userId))?.url ?? null;
    },
  };
  return service;
}
