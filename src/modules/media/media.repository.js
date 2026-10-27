import { fromBin, toBin } from '../../shared/ids.js';

/** Seçilecek sütunlar; `t` JOIN'li sorgularda tablo takma adı. */
const columns = (t = '') => {
  const p = t ? `${t}.` : '';
  return `${p}id, ${p}owner_user_id, ${p}purpose, ${p}visibility, ${p}storage_path,
          CAST(${p}variants AS CHAR) AS variants, ${p}mime, ${p}bytes, ${p}width, ${p}height,
          ${p}blurhash, ${p}sha256, ${p}status, ${p}created_at`;
};
const COLUMNS = columns();

export function toMedia(r) {
  return (
    r && {
      id: fromBin(r.id),
      ownerUserId: r.owner_user_id ? fromBin(r.owner_user_id) : null,
      purpose: r.purpose,
      visibility: r.visibility,
      storagePath: r.storage_path,
      variants: r.variants ? JSON.parse(r.variants) : {},
      mime: r.mime,
      bytes: r.bytes,
      width: r.width ?? null,
      height: r.height ?? null,
      blurhash: r.blurhash ?? null,
      sha256: r.sha256,
      status: r.status,
      createdAt: r.created_at,
    }
  );
}

export async function findMedia(db, id, conn) {
  return toMedia(
    await db.one(`SELECT ${COLUMNS} FROM media WHERE id = :id`, { id: toBin(id) }, conn),
  );
}

/** Aynı kullanıcının son 24 saatte aynı içerikle yüklediği hazır medya (çift yükleme). */
export async function findDuplicate(db, userId, purpose, sha256) {
  return toMedia(
    await db.one(
      `SELECT ${COLUMNS} FROM media
        WHERE owner_user_id = :userId AND sha256 = :sha256 AND purpose = :purpose
          AND status = 'ready' AND created_at >= DATE_SUB(NOW(3), INTERVAL 24 HOUR)
        ORDER BY created_at DESC LIMIT 1`,
      { userId: toBin(userId), sha256, purpose },
    ),
  );
}

export async function insertMedia(db, m, conn) {
  await db.run(
    `INSERT INTO media (id, owner_user_id, purpose, visibility, storage_path, variants, mime, bytes,
                        width, height, blurhash, sha256, status)
     VALUES (:id, :owner, :purpose, :visibility, :path, :variants, :mime, :bytes, :width,
             :height, :blurhash, :sha256, 'processing')`,
    {
      id: toBin(m.id),
      owner: m.ownerUserId ? toBin(m.ownerUserId) : null,
      purpose: m.purpose,
      visibility: m.visibility,
      path: m.storagePath,
      variants: JSON.stringify(m.variants),
      mime: m.mime ?? 'image/webp',
      bytes: m.bytes,
      width: m.width,
      height: m.height,
      blurhash: m.blurhash,
      sha256: m.sha256,
    },
    conn,
  );
}

export async function setStatus(db, id, status, conn) {
  await db.run(
    `UPDATE media SET status = :status,
            deleted_at = IF(:status = 'deleted', NOW(3), deleted_at)
      WHERE id = :id`,
    { id: toBin(id), status },
    conn,
  );
}

/** Birden çok kullanıcının hazır avatarları: `Map<userId, media>` (tek sorgu). */
export async function avatarsOf(db, userIds) {
  if (userIds.length === 0) return new Map();
  const params = Object.fromEntries(userIds.map((id, i) => [`u${i}`, toBin(id)]));
  const rows = await db.many(
    `SELECT u.id AS user_id, ${columns('m')}
       FROM users u JOIN media m ON m.id = u.avatar_media_id
      WHERE u.id IN (${userIds.map((_, i) => `:u${i}`).join(', ')}) AND m.status = 'ready'`,
    params,
  );
  return new Map(rows.map((r) => [fromBin(r.user_id), toMedia(r)]));
}

/** Kullanıcının avatarı (hazır ise). */
export async function avatarOf(db, userId, conn) {
  return toMedia(
    await db.one(
      `SELECT ${columns('m')}
         FROM users u JOIN media m ON m.id = u.avatar_media_id
        WHERE u.id = :userId AND m.status = 'ready'`,
      { userId: toBin(userId) },
      conn,
    ),
  );
}

export async function setAvatar(db, conn, userId, mediaId) {
  await db.run(
    'UPDATE users SET avatar_media_id = :mediaId WHERE id = :userId',
    { userId: toBin(userId), mediaId: mediaId ? toBin(mediaId) : null },
    conn,
  );
}

/** Temizlik adayları (işler). */
export async function stuckProcessing(db, hours, limit) {
  return (
    await db.many(
      `SELECT ${COLUMNS} FROM media
        WHERE status = 'processing' AND created_at < DATE_SUB(NOW(3), INTERVAL :hours HOUR)
        LIMIT :limit`,
      { hours, limit: String(limit) },
    )
  ).map(toMedia);
}

/** Hiçbir öğüne bağlanmamış öğün fotoğrafları. */
export async function unattachedMealPhotos(db, hours, limit) {
  return (
    await db.many(
      `SELECT ${columns('m')}
         FROM media m
        WHERE m.purpose = 'meal_photo' AND m.status = 'ready'
          AND m.created_at < DATE_SUB(NOW(3), INTERVAL :hours HOUR)
          AND NOT EXISTS (SELECT 1 FROM meals ml WHERE ml.photo_media_id = m.id)
        LIMIT :limit`,
      { hours, limit: String(limit) },
    )
  ).map(toMedia);
}

/** Yalnızca uzun süredir silinmiş öğünlere bağlı fotoğraflar. */
export async function photosOfDeletedMeals(db, days, limit) {
  return (
    await db.many(
      `SELECT ${columns('m')}
         FROM media m
        WHERE m.purpose = 'meal_photo' AND m.status = 'ready'
          AND EXISTS (SELECT 1 FROM meals ml WHERE ml.photo_media_id = m.id
                         AND ml.deleted_at < DATE_SUB(NOW(3), INTERVAL :days DAY))
          AND NOT EXISTS (SELECT 1 FROM meals ml WHERE ml.photo_media_id = m.id
                             AND ml.deleted_at IS NULL)
        LIMIT :limit`,
      { days, limit: String(limit) },
    )
  ).map(toMedia);
}

/** Birden çok medya, id → kayıt (listelerde N+1 sorgu olmasın). */
export async function findMany(db, ids) {
  if (ids.length === 0) return new Map();
  const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, toBin(id)]));
  const rows = await db.many(
    `SELECT ${COLUMNS} FROM media WHERE id IN (${ids.map((_, i) => `:id${i}`).join(', ')})`,
    params,
  );
  return new Map(rows.map((r) => [fromBin(r.id), toMedia(r)]));
}
