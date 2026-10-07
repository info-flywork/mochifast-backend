import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafePath,
  bunnyToken,
  createMediaStorage,
  expiryBucket,
} from '../../src/infra/bunny.js';
import {
  MAX_INPUT_PIXELS,
  ownerKey,
  processImage,
  storagePrefix,
} from '../../src/modules/media/media.pipeline.js';

/** Test görseli: düz renk JPEG; istenirse EXIF (iPhone + GPS) ve yön bilgisiyle. */
async function jpeg(width, height, { exif = false, orientation } = {}) {
  let img = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } },
  }).jpeg({ quality: 90 });
  if (exif) {
    img = img.withExif({
      IFD0: { Make: 'Apple', Model: 'iPhone 15 Pro' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '41/1 0/1 82/10', GPSLongitudeRef: 'E' },
    });
  }
  const buf = await img.toBuffer();
  return orientation ? sharp(buf).withMetadata({ orientation }).jpeg().toBuffer() : buf;
}

/** Yalnızca başlığı geçerli, piksel verisi küçük PNG: boyut iddiası dekompresyon bombası gibi. */
function pngClaiming(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit derinliği
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('Bunny imzalı URL', () => {
  it('token: base64url(sha256(anahtar + yol + bitiş)) — openssl ile bağımsız hesaplanan değer', () => {
    // printf '%s' 'bunny-test-key/u/…_512.webp1767225600' | openssl dgst -sha256 -binary | base64
    expect(
      bunnyToken('bunny-test-key', '/u/0a1b2c3d4e5f60718293/avatar/01a1-test_512.webp', 1767225600),
    ).toBe('CyvjOzRSocbqCtdTqAafSnIrSPT1Uv2uEBAW0inaMLw');
  });

  it('bitiş saat başına yuvarlanır: aynı saatte aynı URL, en az TTL kadar geçerli', () => {
    const t = Date.UTC(2026, 0, 1, 10, 5);
    expect(expiryBucket(t, 6 * 3600)).toBe(Date.UTC(2026, 0, 1, 17) / 1000);
    expect(expiryBucket(t + 40 * 60_000, 6 * 3600)).toBe(Date.UTC(2026, 0, 1, 17) / 1000);
  });

  it("URL biçimi ve doğrulama; token'sız, bozuk ya da süresi geçmiş → reddedilir", () => {
    const storage = createMediaStorage(
      {
        driver: 'bunny',
        urlTtlSec: 3600,
        privateZone: { pullHost: 'media.example.net', tokenKey: 'k' },
        publicZone: { pullHost: 'cdn.example.net' },
      },
      { fetchImpl: () => {} },
    );
    const path = 'u/abc/meals/2026/10/x_1024.webp';
    const now = Date.UTC(2026, 0, 1, 10);
    const { url, expiresAt } = storage.signPrivateUrl(path, { now });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`https://media.example.net/${path}`);
    expect([...u.searchParams.keys()]).toEqual(['token', 'expires']);
    expect(expiresAt).toBe('2026-01-01T11:00:00.000Z');
    const [token, expires] = [u.searchParams.get('token'), u.searchParams.get('expires')];
    expect(storage.verifyPrivateToken(path, token, expires, now)).toBe(true);
    expect(storage.verifyPrivateToken(path, undefined, expires, now)).toBe(false);
    expect(storage.verifyPrivateToken(path, `${token}x`, expires, now)).toBe(false);
    expect(storage.verifyPrivateToken('u/abc/other.webp', token, expires, now)).toBe(false);
    expect(storage.verifyPrivateToken(path, token, expires, now + 2 * 3600_000)).toBe(false);
    expect(storage.publicUrl('p/insights/ab_md.webp')).toBe(
      'https://cdn.example.net/p/insights/ab_md.webp',
    );
  });

  it('depolama yolu: kök dışına çıkamaz', () => {
    for (const bad of ['../etc/passwd', '/abs', 'a/../../b', 'a\\b', 'a b', '']) {
      expect(() => assertSafePath(bad)).toThrow();
    }
    expect(assertSafePath('u/ab12/avatar/01-x_512.webp')).toBe('u/ab12/avatar/01-x_512.webp');
  });
});

describe('yükleme hattı', () => {
  it('kabul kriteri: EXIF/GPS içeren iPhone fotoğrafının hiçbir varyantında metadata yok', async () => {
    const input = await jpeg(1200, 900, { exif: true });
    expect((await sharp(input).metadata()).exif?.toString('latin1')).toContain('Apple');
    const out = await processImage(input, 'meal_photo');
    for (const v of Object.values(out.variants)) {
      const meta = await sharp(v.buffer).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(v.buffer.includes(Buffer.from('iPhone'))).toBe(false);
    }
  });

  it('EXIF yönü piksellere uygulanır (dikey çekim dikey kalır)', async () => {
    const out = await processImage(await jpeg(800, 400, { orientation: 6 }), 'avatar');
    expect(out.variants.md).toMatchObject({ width: 256, height: 512 });
  });

  it('varyantlar: uzun kenar sınırı, büyütme yok, blurhash ve sha256', async () => {
    const out = await processImage(await jpeg(3000, 2000), 'meal_photo');
    expect(out.variants.lg).toMatchObject({ width: 1600, height: 1067 });
    expect(out.variants.md).toMatchObject({ width: 1024, height: 683 });
    expect(out.variants.thumb).toMatchObject({ width: 256, height: 171 });
    expect(out.blurhash.length).toBeGreaterThan(6);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    const small = await processImage(await jpeg(300, 200), 'meal_photo');
    expect(small.variants.lg).toMatchObject({ width: 300, height: 200 });
  });

  it('dekompresyon bombası (30000×30000 PNG başlığı) → 413', async () => {
    expect(30000 * 30000).toBeGreaterThan(MAX_INPUT_PIXELS);
    await expect(processImage(pngClaiming(30000, 30000), 'meal_photo')).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('HEIC, SVG, PDF (uzantısı jpg olsa da) → 415', async () => {
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('mif1heic'),
      Buffer.alloc(64),
    ]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const pdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');
    for (const buf of [heic, svg, pdf, Buffer.from('not an image')]) {
      await expect(processImage(buf, 'meal_photo')).rejects.toMatchObject({
        code: 'UNSUPPORTED_MEDIA_TYPE',
      });
    }
    await expect(processImage(heic, 'avatar')).rejects.toMatchObject({
      details: { hint: 'convert_to_jpeg' },
    });
  });

  it('yol öneki kullanıcı kimliği içermez, kararlıdır', () => {
    const key = ownerKey('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 's'.repeat(32));
    expect(key).toMatch(/^[0-9a-f]{20}$/);
    expect(ownerKey('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 's'.repeat(32))).toBe(key);
    expect(
      storagePrefix('meal_photo', { ownerKey: key, mediaId: 'm1', now: new Date('2026-03-04') }),
    ).toBe(`u/${key}/meals/2026/03/m1`);
    expect(storagePrefix('avatar', { ownerKey: key, mediaId: 'm1' })).toBe(`u/${key}/avatar/m1`);
  });
});

describe('yerel sürücü', () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-unit-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('yaz, listele, sil', async () => {
    const storage = createMediaStorage(
      { driver: 'local', localDir: dir, urlTtlSec: 3600, privateZone: { tokenKey: 'k' } },
      { baseUrl: 'http://x' },
    );
    await storage.private.put('u/ab/avatar/1_512.webp', Buffer.from('a'));
    await storage.private.put('u/ab/meals/2026/10/2_256.webp', Buffer.from('b'));
    expect((await storage.private.list('u/ab')).sort()).toEqual([
      'u/ab/avatar/1_512.webp',
      'u/ab/meals/2026/10/2_256.webp',
    ]);
    await storage.private.delete('u/ab/avatar/1_512.webp');
    expect(await storage.private.list('u/ab')).toEqual(['u/ab/meals/2026/10/2_256.webp']);
    expect(storage.signPrivateUrl('u/ab/x.webp').url).toMatch(
      /^http:\/\/x\/media-files\/u\/ab\/x\.webp\?token=[\w-]+&expires=\d+$/,
    );
  });
});
