import { createHash, createHmac } from 'node:crypto';
import { encode } from 'blurhash';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { AppError } from '../../shared/errors.js';

/**
 * Yükleme hattı (docs/backend/08-medya-bunny.md §4). Orijinal hiç saklanmaz: her varyant
 * yeniden kodlanmış WebP'dir. sharp varsayılan olarak tüm metadata'yı (EXIF/GPS/XMP/ICC) atar;
 * `.rotate()` EXIF yönünü piksellere uygular, böylece yön bilgisi de gerekmez.
 */

/** Kabul edilen gerçek içerik türleri (uzantıya/Content-Type'a bakılmaz, magic byte'a bakılır). */
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Dekompresyon bombasına karşı: çözülmeden önce reddedilir. */
export const MAX_INPUT_PIXELS = 40_000_000;
const WEBP = { quality: 80, effort: 4 };

/** Amaç → varyantlar (uzun kenar, px) ve görünürlük. */
export const PURPOSES = Object.freeze({
  avatar: { visibility: 'private', variants: { md: 512, thumb: 128 }, main: 'md' },
  meal_photo: {
    visibility: 'private',
    variants: { lg: 1600, md: 1024, thumb: 256 },
    main: 'md',
  },
  // Yönetim paneli içerik görselleri (public zone, kalıcı URL; 08 §7).
  insight_cover: { visibility: 'public', variants: { lg: 1600, md: 960, thumb: 320 }, main: 'md' },
  challenge_image: { visibility: 'public', variants: { md: 1024, thumb: 256 }, main: 'md' },
  plan_image: { visibility: 'public', variants: { md: 1024, thumb: 256 }, main: 'md' },
});

/** Kullanıcı kimliğinden geri çıkarılamayan, kararlı yol öneki (hesap silmede önekle silinir). */
export function ownerKey(userId, secret) {
  return createHmac('sha256', secret).update(userId).digest('hex').slice(0, 20);
}

/** Varyantların ortak öneki (uzantısız). */
export function storagePrefix(purpose, { ownerKey: key, mediaId, now = new Date() }) {
  if (purpose === 'avatar') return `u/${key}/avatar/${mediaId}`;
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  // Public içerik görselleri kullanıcıya bağlı değildir.
  if (PURPOSES[purpose]?.visibility === 'public') return `p/${purpose}/${yyyy}/${mm}/${mediaId}`;
  return `u/${key}/meals/${yyyy}/${mm}/${mediaId}`;
}

export async function detectImage(buffer) {
  const type = await fileTypeFromBuffer(buffer);
  if (!type || !ACCEPTED.has(type.mime)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
      details: {
        detected: type?.mime ?? null,
        accepted: [...ACCEPTED],
        // HEIC/HEIF: istemci JPEG'e çevirip göndermeli.
        hint: type?.mime?.startsWith('image/hei') ? 'convert_to_jpeg' : undefined,
      },
    });
  }
  return type.mime;
}

/**
 * @returns {sha256, width, height, blurhash, variants: {name: {buffer, width, height, bytes}}}
 */
export async function processImage(buffer, purpose) {
  const spec = PURPOSES[purpose];
  if (!spec) throw new AppError('VALIDATION_FAILED', { details: { purpose } });
  await detectImage(buffer);

  const open = () => sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
  let meta;
  try {
    meta = await open().metadata();
  } catch (err) {
    throw decodeError(err, 'unreadable');
  }
  if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_INPUT_PIXELS) throw pixelLimit();

  const variants = {};
  try {
    for (const [name, size] of Object.entries(spec.variants)) {
      const { data, info } = await open()
        .rotate()
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp(WEBP)
        .toBuffer({ resolveWithObject: true });
      variants[name] = { buffer: data, width: info.width, height: info.height, bytes: data.length };
    }
  } catch (err) {
    throw decodeError(err, 'decode');
  }

  const main = variants[spec.main];
  return {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    width: main.width,
    height: main.height,
    blurhash: await blurhashOf(variants[spec.main].buffer),
    variants,
  };
}

const pixelLimit = (cause) =>
  new AppError('PAYLOAD_TOO_LARGE', {
    cause,
    details: { reason: 'pixel_limit', maxPixels: MAX_INPUT_PIXELS },
  });

/** sharp hatası: piksel sınırı 413, diğerleri (bozuk/okunamayan dosya) 415. */
function decodeError(err, reason) {
  if (/pixel limit/i.test(err?.message ?? '')) return pixelLimit(err);
  return new AppError('UNSUPPORTED_MEDIA_TYPE', { cause: err, details: { reason } });
}

/** Liste yer tutucusu: 32 px'e küçültülmüş görselden 4×3 bileşenli blurhash. */
async function blurhashOf(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(32, 32, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
}
