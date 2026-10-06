import { Redis } from 'ioredis';

/**
 * İki ayrı Redis (docs/backend/07-cache-performans.md §2):
 * - cache  : `allkeys-lru` — cache, rate limit, idempotency, kilitler. Erişilemezse cache fail-open.
 * - queue  : `noeviction` + AOF — BullMQ. İş kaybı kabul edilemez.
 */

/**
 * Cache bağlantısı: komutlar bağlantı yokken kuyrukta beklemez, hızlıca hata verir
 * (istek süresini Redis kesintisine bağlamamak için).
 */
export function createCacheRedis(url, logger) {
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  attachLogging(client, 'cache', logger);
  return client;
}

/**
 * BullMQ bağlantı ayarları. BullMQ engelleyici komutlar kullandığı için
 * `maxRetriesPerRequest: null` zorunlu.
 */
export function queueConnectionOptions(url) {
  return { url, maxRetriesPerRequest: null, enableReadyCheck: true };
}

export function createQueueRedis(url, logger) {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
  attachLogging(client, 'queue', logger);
  return client;
}

/**
 * Bağlantıyı açmayı dener; başarısız olursa uygulamayı düşürmez (ioredis arka planda yeniden dener).
 */
export async function connectSoftly(client, logger) {
  try {
    await client.connect();
  } catch (err) {
    logger?.warn({ err }, 'redis bağlantısı kurulamadı; arka planda tekrar denenecek');
  }
}

/**
 * Bağlantıyı kapatır ve ASLA takılmaz: bağlıysa bekleyen komutları bitirip `QUIT`, bağlı değilse
 * (Redis kesintisi) doğrudan `disconnect` — çevrimdışı kuyruğu açık bir istemcide `quit()`
 * bağlantı gelene kadar sonsuza dek bekler.
 */
export async function closeRedis(client, timeoutMs = 2_000) {
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }
  let timer;
  try {
    await Promise.race([
      client.quit(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // quit() sonrası durum değişir; TS daraltmasını aşmak için string olarak oku.
    if (client.status !== 'end') client.disconnect();
  }
}

function attachLogging(client, name, logger) {
  let lastErrorLog = 0;
  client.on('error', (err) => {
    // Kesinti sırasında saniyede yüzlerce satır basmamak için 10 sn'de bir logla.
    const now = Date.now();
    if (now - lastErrorLog > 10_000) {
      lastErrorLog = now;
      logger?.warn({ redis: name, err: err.message }, 'redis hatası');
    }
  });
  client.on('ready', () => logger?.info({ redis: name }, 'redis hazır'));
}
