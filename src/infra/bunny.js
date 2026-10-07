import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Medya depolaması (docs/backend/08-medya-bunny.md). İki zone:
 * - private: kullanıcı fotoğrafları; yalnızca imzalı (Token Authentication) URL ile okunur.
 * - public : yönetim içeriği; kalıcı, token'sız URL.
 * `driver: 'local'` geliştirme/testte dosyaları diske yazar; imzalı URL'ler API'nin
 * `/media-files/*` ucuna gider ve aynı algoritmayla doğrulanır.
 */

const PUT_ATTEMPTS = 3;
const HOUR_SEC = 3600;

/**
 * Bunny Token Authentication (SHA-256): base64url(sha256(anahtar + yol + bitiş)), `=` atılır.
 * Ek parametre ve IP bağlama kullanılmaz (mobil ağda IP sık değişir).
 * @param path "/" ile başlayan CDN yolu
 */
export function bunnyToken(key, path, expires) {
  return createHash('sha256')
    .update(`${key}${path}${expires}`)
    .digest('base64')
    .replace(/\n/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Bitiş saati saat başına yukarı yuvarlanır: aynı saat içindeki yanıtlar aynı URL'yi döner
 * (istemci ve edge cache verimli), geçerlilik en az `ttlSec` olur.
 */
export function expiryBucket(nowMs, ttlSec) {
  return Math.ceil((Math.floor(nowMs / 1000) + ttlSec) / HOUR_SEC) * HOUR_SEC;
}

/** Yol "u/…" biçiminde, ".." ve mutlak yol içermez. */
export function assertSafePath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 400 ||
    path.startsWith('/') ||
    path.includes('..') ||
    path.includes('\\') ||
    !/^[A-Za-z0-9/_.-]+$/.test(path)
  ) {
    throw new Error(`Geçersiz depolama yolu: ${path}`);
  }
  return path;
}

function bunnyZone({ zone, password, storageHost }, { fetchImpl, apiKey, pullHost, logger }) {
  const base = `https://${storageHost}/${zone}/`;
  return {
    async put(path, body, contentType = 'application/octet-stream') {
      const checksum = createHash('sha256').update(body).digest('hex').toUpperCase();
      let lastError;
      for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt += 1) {
        try {
          const res = await fetchImpl(base + assertSafePath(path), {
            method: 'PUT',
            headers: { AccessKey: password, 'Content-Type': contentType, Checksum: checksum },
            body,
          });
          if (res.ok) return;
          lastError = new Error(`Bunny PUT ${res.status}`);
          if (res.status < 500 && res.status !== 429) break; // kalıcı hata: tekrar deneme
        } catch (err) {
          lastError = err;
        }
        if (attempt < PUT_ATTEMPTS) await sleep(200 * 2 ** (attempt - 1));
      }
      logger?.error({ err: lastError, path }, 'Bunny yükleme başarısız');
      throw lastError;
    },

    async get(path) {
      const res = await fetchImpl(base + assertSafePath(path), {
        headers: { AccessKey: password, Accept: '*/*' },
      });
      if (!res.ok) throw new Error(`Bunny GET ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },

    async delete(path) {
      const res = await fetchImpl(base + assertSafePath(path), {
        method: 'DELETE',
        headers: { AccessKey: password },
      });
      if (!res.ok && res.status !== 404) throw new Error(`Bunny DELETE ${res.status}`);
    },

    /** Dizindeki dosyalar (alt dizinlere iner). */
    async list(prefix) {
      const dir = assertSafePath(prefix.replace(/\/?$/, '/'));
      const res = await fetchImpl(base + dir, { headers: { AccessKey: password, Accept: '*/*' } });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`Bunny LIST ${res.status}`);
      const out = [];
      for (const item of await res.json()) {
        const child = `${dir}${item.ObjectName}`;
        if (item.IsDirectory) out.push(...(await this.list(child)));
        else out.push(child);
      }
      return out;
    },

    /** Pull zone cache'ini temizler; `*` ile önek. */
    async purge(path) {
      if (!apiKey || !pullHost) return;
      const url = `https://${pullHost}/${path}`;
      const res = await fetchImpl(
        `https://api.bunny.net/purge?url=${encodeURIComponent(url)}&async=true`,
        { method: 'POST', headers: { AccessKey: apiKey } },
      );
      if (!res.ok) throw new Error(`Bunny purge ${res.status}`);
    },
  };
}

function localZone(root) {
  const full = (path) => {
    const target = resolve(root, normalize(assertSafePath(path)));
    if (!target.startsWith(resolve(root) + sep)) throw new Error('Yol kök dışına çıkıyor');
    return target;
  };
  return {
    root,
    full,
    async put(path, body) {
      const target = full(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    },
    async get(path) {
      return readFile(full(path));
    },
    async delete(path) {
      await rm(full(path), { force: true });
    },
    async list(prefix) {
      const dir = full(prefix.replace(/\/$/, ''));
      try {
        const entries = await readdir(dir, { recursive: true, withFileTypes: true });
        return entries
          .filter((d) => d.isFile())
          .map((d) => join(d.parentPath ?? d.path, d.name).slice(resolve(root).length + 1));
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
    async purge() {},
  };
}

/**
 * @param media config.media
 * @param baseUrl local sürücüde imzalı URL'lerin kökü (ör. http://localhost:3000)
 */
export function createMediaStorage(media, { fetchImpl = fetch, logger, baseUrl = '' } = {}) {
  const local = media.driver === 'local';
  const privateZone = local
    ? localZone(resolve(media.localDir, 'private'))
    : bunnyZone(media.privateZone, {
        fetchImpl,
        apiKey: media.apiKey,
        pullHost: media.privateZone.pullHost,
        logger,
      });
  const publicZone = local
    ? localZone(resolve(media.localDir, 'public'))
    : bunnyZone(media.publicZone, {
        fetchImpl,
        apiKey: media.apiKey,
        pullHost: media.publicZone.pullHost,
        logger,
      });
  const privateBase = local ? `${baseUrl}/media-files` : `https://${media.privateZone.pullHost}`;

  return {
    driver: media.driver,
    private: privateZone,
    public: publicZone,

    /** Private dosya için imzalı URL. */
    signPrivateUrl(path, { ttlSec = media.urlTtlSec, now = Date.now() } = {}) {
      const signed = `/${assertSafePath(path)}`;
      const expires = expiryBucket(now, ttlSec);
      const token = bunnyToken(media.privateZone.tokenKey, signed, expires);
      return {
        url: `${privateBase}${signed}?token=${token}&expires=${expires}`,
        expiresAt: new Date(expires * 1000).toISOString(),
      };
    },

    /** local sürücünün dosya ucu için doğrulama (Bunny edge'inin yaptığı kontrolün aynısı). */
    verifyPrivateToken(path, token, expires, now = Date.now()) {
      const exp = Number(expires);
      if (!Number.isInteger(exp) || exp * 1000 < now) return false;
      const expected = Buffer.from(bunnyToken(media.privateZone.tokenKey, `/${path}`, exp));
      const given = Buffer.from(String(token ?? ''));
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    publicUrl(path) {
      return local
        ? `${baseUrl}/media-public/${assertSafePath(path)}`
        : `https://${media.publicZone.pullHost}/${assertSafePath(path)}`;
    },
  };
}
