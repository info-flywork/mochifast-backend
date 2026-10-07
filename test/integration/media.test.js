import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { mediaJobs } from '../../src/jobs/media.jobs.js';
import { toBin } from '../../src/shared/ids.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const silent = { info() {}, warn() {}, error() {} };

/** Tek dosyalı multipart gövdesi. */
function multipart(buffer, { filename = 'photo.jpg', contentType = 'image/jpeg' } = {}) {
  const boundary = `----mochi${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const photo = (color = { r: 30, g: 160, b: 90 }, size = [1400, 1000]) =>
  sharp({ create: { width: size[0], height: size[1], channels: 3, background: color } })
    .withExif({ IFD0: { Make: 'Apple', Model: 'iPhone 15 Pro' } })
    .jpeg()
    .toBuffer();

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

describe.skipIf(!mysqlUrl)('medya: avatar, öğün fotoğrafı, imzalı URL (gerçek MySQL)', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function newUser() {
    const { token, user } = (await ctx.guest(randomUUID())).json().data;
    return { token: token.accessToken, userId: user.id };
  }

  /** multipart gövdeli istek (`call` JSON gövdesi yollar). */
  function upload(method, url, token, buffer, options) {
    const { payload, headers } = multipart(buffer, options);
    return ctx.app.inject({
      method,
      url: `/v1${url}`,
      payload,
      headers: { ...headers, authorization: `Bearer ${token}` },
    });
  }
  /** İmzalı URL'yi (yerel sürücü: http://media.test/media-files/…) uygulamadan indirir. */
  const download = (url) => {
    const u = new URL(url);
    return ctx.app.inject({ method: 'GET', url: u.pathname + u.search });
  };
  const fileOf = (url) =>
    join(ctx.mediaDir, 'private', new URL(url).pathname.slice('/media-files/'.length));

  it("avatar: yükle → imzalı URL, EXIF yok; token'sız/bozuk/süresi geçmiş 403; değişince eskisi silinir", async () => {
    const { token } = await newUser();
    const res = await upload('PUT', '/user/me/avatar', token, await photo());
    expect(res.statusCode).toBe(200);
    const avatar = res.json().data.avatar;
    expect(avatar.url).toMatch(
      /^http:\/\/media\.test\/media-files\/u\/[0-9a-f]{20}\/avatar\/[\w-]+_512\.webp\?token=[\w-]+&expires=\d+$/,
    );
    expect(Object.keys(avatar.variants).sort()).toEqual(['md', 'thumb']);
    expect(avatar).toMatchObject({ width: 512, height: 366 });
    expect(avatar.blurhash).toBeTruthy();

    const me = await ctx.call('GET', '/user/me', { token });
    expect(me.json().data.avatarUrl).toBe(avatar.url);

    const file = await download(avatar.url);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/webp');
    const meta = await sharp(file.rawPayload).metadata();
    expect(meta.exif).toBeUndefined();
    expect(file.rawPayload.includes(Buffer.from('iPhone'))).toBe(false);

    const u = new URL(avatar.url);
    expect((await ctx.app.inject({ method: 'GET', url: u.pathname })).statusCode).toBe(403);
    u.searchParams.set('token', 'x'.repeat(43));
    expect((await download(u.toString())).statusCode).toBe(403);
    const expired = new URL(avatar.url);
    expired.searchParams.set('expires', String(Math.floor(Date.now() / 1000) - 60));
    expect((await download(expired.toString())).statusCode).toBe(403);

    const oldFile = fileOf(avatar.url);
    expect(await exists(oldFile)).toBe(true);
    const second = (
      await upload('PUT', '/user/me/avatar', token, await photo({ r: 1, g: 2, b: 3 }))
    ).json().data.avatar;
    expect(second.id).not.toBe(avatar.id);
    expect(await exists(oldFile)).toBe(false);

    expect((await ctx.call('DELETE', '/user/me/avatar', { token })).statusCode).toBe(200);
    expect((await ctx.call('GET', '/user/me', { token })).json().data.avatarUrl).toBeNull();
    expect(await exists(fileOf(second.url))).toBe(false);
  });

  it('öğün fotoğrafı: yükle (yineleme aynı kaydı döner) → öğüne bağla → listede imzalı URL', async () => {
    const { token } = await newUser();
    const img = await photo({ r: 200, g: 10, b: 10 }, [2400, 1800]);
    const first = await upload('POST', '/media?purpose=mealPhoto', token, img);
    expect(first.statusCode).toBe(201);
    const media = first.json().data.media;
    expect(Object.keys(media.variants).sort()).toEqual(['lg', 'md', 'thumb']);
    expect(media.url).toContain('_1024.webp?token=');
    const again = await upload('POST', '/media?purpose=mealPhoto', token, img);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.media.id).toBe(media.id);

    const meal = await ctx.call('POST', '/meals', {
      token,
      body: { title: 'Salata', kcal: 300, photoMediaId: media.id },
    });
    expect(meal.statusCode).toBe(201);
    expect(meal.json().data.meal.photo).toMatchObject({ id: media.id, blurhash: media.blurhash });
    const list = (await ctx.call('GET', '/meals', { token })).json().data.items;
    expect(list[0].photo.thumbUrl).toContain('_256.webp?token=');
    expect((await download(list[0].photo.thumbUrl)).statusCode).toBe(200);

    // Başkasının medyası ne okunur ne bağlanır.
    const other = await newUser();
    expect((await ctx.call('GET', `/media/${media.id}`, { token: other.token })).statusCode).toBe(
      404,
    );
    const steal = await ctx.call('POST', '/meals', {
      token: other.token,
      body: { kcal: 1, photoMediaId: media.id },
    });
    expect(steal.statusCode).toBe(404);

    const unlink = await ctx.call('PATCH', `/meals/${meal.json().data.meal.id}`, {
      token,
      body: { photoMediaId: null },
    });
    expect(unlink.json().data.meal.photo).toBeNull();
  });

  it('kabul kriteri: 10 MB üstü 413; multipart olmayan 415; HEIC 415', async () => {
    const { token } = await newUser();
    const big = Buffer.concat([await photo(), Buffer.alloc(10 * 1024 * 1024 + 1)]);
    expect((await upload('POST', '/media?purpose=mealPhoto', token, big)).statusCode).toBe(413);
    const json = await ctx.call('POST', '/media?purpose=mealPhoto', { token, body: { a: 1 } });
    expect(json.statusCode).toBe(415);
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.alloc(4),
      Buffer.from('mif1heic'),
      Buffer.alloc(64),
    ]);
    const res = await upload('POST', '/media?purpose=mealPhoto', token, heic, {
      filename: 'a.jpg',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('temizlik: 24 saattir öğüne bağlanmamış fotoğraf silinir, bağlı olan kalır', async () => {
    const { token } = await newUser();
    const loose = (
      await upload('POST', '/media?purpose=mealPhoto', token, await photo({ r: 9, g: 9, b: 9 }))
    ).json().data.media;
    const kept = (
      await upload('POST', '/media?purpose=mealPhoto', token, await photo({ r: 8, g: 8, b: 8 }))
    ).json().data.media;
    await ctx.call('POST', '/meals', { token, body: { kcal: 10, photoMediaId: kept.id } });
    await ctx.db.run(
      'UPDATE media SET created_at = DATE_SUB(NOW(3), INTERVAL 25 HOUR) WHERE id IN (:a, :b)',
      { a: toBin(loose.id), b: toBin(kept.id) },
    );
    const jobs = mediaJobs({
      db: ctx.db,
      storage: ctx.storage,
      config: ctx.config.media,
      logger: silent,
    });
    await jobs.mediaUnattached();
    const status = async (id) =>
      (await ctx.db.one('SELECT status FROM media WHERE id = :id', { id: toBin(id) })).status;
    expect(await status(loose.id)).toBe('deleted');
    expect(await exists(fileOf(loose.url))).toBe(false);
    expect(await status(kept.id)).toBe('ready');
    expect((await ctx.call('GET', `/media/${loose.id}`, { token })).statusCode).toBe(404);
  });
});
