/** Uygulamanın desteklediği diller (Flutter `assets/translations` ile aynı). */
export const SUPPORTED_LOCALES = ['en', 'tr', 'de', 'es', 'fr', 'it', 'ru'];

export const DEFAULT_LOCALE = 'en';

export const PLATFORMS = ['ios', 'android'];

/** İstemcinin gönderdiği standart header'lar (docs/backend/02-mimari.md §4.3). */
export const HEADERS = Object.freeze({
  requestId: 'x-request-id',
  timezone: 'x-timezone',
  appVersion: 'x-app-version',
  platform: 'x-platform',
  installId: 'x-install-id',
  idempotencyKey: 'idempotency-key',
});

/** API sürüm öneki. */
export const API_PREFIX = '/v1';

/** İş kuyruğu adları (`jobs.queue`). Yeni kuyruklar fazlarla eklenir. */
export const QUEUES = Object.freeze({
  system: 'system',
});

/** Cache anahtar ad alanları (docs/backend/07-cache-performans.md §3). */
export const CACHE_NAMESPACES = Object.freeze({
  catalog: 'cat',
  config: 'cfg',
  user: 'u',
});
