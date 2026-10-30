import { envSchema } from 'env-schema';

/**
 * Ortam değişkenlerinin şeması. Eksik/hatalı değer → process başlamaz (fail-fast).
 * Açıklamalar için `.env.example` dosyasına bakın.
 */
const schema = {
  type: 'object',
  required: [
    'DB_HOST',
    'DB_USER',
    'DB_NAME',
    'JWT_PRIVATE_JWK',
    'JWT_PUBLIC_JWKS',
    'FIELD_ENCRYPTION_KEYS_JSON',
    'FIELD_ENCRYPTION_ACTIVE_KID',
  ],
  properties: {
    NODE_ENV: {
      type: 'string',
      enum: ['development', 'test', 'staging', 'production'],
      default: 'development',
    },
    HOST: { type: 'string', default: '0.0.0.0' },
    PORT: { type: 'integer', minimum: 1, maximum: 65535, default: 3000 },
    PUBLIC_BASE_URL: { type: 'string', default: '' },
    APP_RELEASE: { type: 'string', default: 'dev' },
    LOG_LEVEL: {
      type: 'string',
      enum: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      default: 'info',
    },
    TRUST_PROXY: { type: 'string', default: 'false' },
    BODY_LIMIT_BYTES: { type: 'integer', minimum: 1024, default: 65_536 },
    SHUTDOWN_GRACE_MS: { type: 'integer', minimum: 1000, default: 25_000 },
    SHUTDOWN_DRAIN_MS: { type: 'integer', minimum: 0, default: 0 },

    DB_HOST: { type: 'string' },
    DB_PORT: { type: 'integer', default: 3306 },
    DB_USER: { type: 'string' },
    DB_PASSWORD: { type: 'string', default: '' },
    DB_NAME: { type: 'string' },
    DB_SSL: { type: 'boolean', default: false },
    DB_SSL_CA: { type: 'string', default: '' },
    DB_SSL_VERIFY: { type: 'boolean', default: true },
    DB_POOL_SIZE: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
    DB_SLOW_QUERY_MS: { type: 'integer', minimum: 1, default: 200 },

    CACHE_MAX_ENTRIES: { type: 'integer', minimum: 100, default: 10_000 },

    WORKER_CONCURRENCY: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
    WORKER_POLL_MS: { type: 'integer', minimum: 100, default: 1_000 },

    JWT_PRIVATE_JWK: { type: 'string' },
    JWT_PUBLIC_JWKS: { type: 'string' },
    JWT_ISSUER: { type: 'string', default: 'api.mochifast.app' },
    JWT_AUDIENCE: { type: 'string', default: 'mochifast-app' },
    JWT_ACCESS_TTL_SEC: { type: 'integer', minimum: 60, maximum: 3600, default: 900 },
    REFRESH_TTL_DAYS: { type: 'integer', minimum: 1, maximum: 365, default: 60 },
    // Oturum ailesinin mutlak ömrü: bu süreden sonra yeniden giriş (misafir: installId ile otomatik).
    REFRESH_ABSOLUTE_DAYS: { type: 'integer', minimum: 7, maximum: 730, default: 180 },
    JWT_ADMIN_AUDIENCE: { type: 'string', default: 'mochifast-admin' },
    ADMIN_TOKEN_TTL_SEC: { type: 'integer', minimum: 300, maximum: 3600, default: 3600 },
    // Virgülle ayrılmış IP/CIDR (ör. 203.0.113.7,10.0.0.0/8).
    ADMIN_IP_ALLOWLIST: { type: 'string', default: '' },
    // Üretimde allowlist boşsa admin API kapalıdır; bilinçli olarak her IP'ye açmak için true.
    ADMIN_ALLOW_ANY_IP: { type: 'boolean', default: false },

    FIELD_ENCRYPTION_KEYS_JSON: { type: 'string' },
    FIELD_ENCRYPTION_ACTIVE_KID: { type: 'integer', minimum: 1, maximum: 255 },

    FIREBASE_PROJECT_ID: { type: 'string', default: '' },
    FIREBASE_SIGN_IN_PROVIDERS: { type: 'string', default: 'apple.com,google.com' },

    CORS_ORIGINS: { type: 'string', default: '' },
    RATE_LIMIT_GLOBAL_MAX: { type: 'integer', minimum: 1, default: 600 },
    RATE_LIMIT_WINDOW: { type: 'string', default: '1 minute' },

    METRICS_ENABLED: { type: 'boolean', default: true },
    METRICS_HOST: { type: 'string', default: '0.0.0.0' },
    METRICS_PORT: { type: 'integer', minimum: 1, maximum: 65535, default: 9464 },
    METRICS_WORKER_PORT: { type: 'integer', minimum: 1, maximum: 65535, default: 9465 },

    DOCS_ENABLED: { type: 'boolean', default: false },
    DOCS_USER: { type: 'string', default: '' },
    DOCS_PASSWORD: { type: 'string', default: '' },

    // Medya (docs/backend/08-medya-bunny.md). local: geliştirme/test (diske yazar, API sunar).
    MEDIA_DRIVER: { type: 'string', enum: ['local', 'bunny'], default: 'local' },
    MEDIA_LOCAL_DIR: { type: 'string', default: 'var/media' },
    MEDIA_PATH_SECRET: { type: 'string', default: '' },
    MEDIA_UPLOAD_MAX_BYTES: { type: 'integer', minimum: 65_536, default: 10 * 1024 * 1024 },
    MEDIA_URL_TTL_SEC: { type: 'integer', minimum: 300, maximum: 7 * 86_400, default: 6 * 3600 },
    // Public zone: uygulama görselleri ve yönetim içeriği (token yok).
    BUNNY_STORAGE_ZONE: { type: 'string', default: '' },
    BUNNY_STORAGE_PASSWORD: { type: 'string', default: '' },
    BUNNY_STORAGE_HOST: { type: 'string', default: 'storage.bunnycdn.com' },
    BUNNY_PULL_ZONE_HOST: { type: 'string', default: '' },
    // Private zone: kullanıcı fotoğrafları; pull zone'da Token Authentication AÇIK olmalı.
    BUNNY_PRIVATE_STORAGE_ZONE: { type: 'string', default: '' },
    BUNNY_PRIVATE_STORAGE_PASSWORD: { type: 'string', default: '' },
    BUNNY_PRIVATE_STORAGE_HOST: { type: 'string', default: 'storage.bunnycdn.com' },
    BUNNY_PRIVATE_PULL_ZONE_HOST: { type: 'string', default: '' },
    BUNNY_TOKEN_AUTH_KEY: { type: 'string', default: '' },
    BUNNY_API_KEY: { type: 'string', default: '' },

    // Yapay zekâ (docs/backend/09-yapay-zeka.md). OpenAI anahtarı yoksa AI uçları 503 döner.
    AI_ANALYSIS_TIMEOUT_MS: { type: 'integer', minimum: 5_000, default: 45_000 },
    // Sohbet + fotoğraf analizi: OpenAI. Anahtar + ilgili model verilmezse o özellik 503 döner.
    OPENAI_API_KEY: { type: 'string', default: '' },
    OPENAI_CHAT_MODEL: { type: 'string', default: '' },
    OPENAI_VISION_MODEL: { type: 'string', default: 'gpt-4o' },
    // Sohbet modeli için; yalnızca akıl yürüten (reasoning) modellerde gönderilir. Boş = gönderme.
    OPENAI_REASONING_EFFORT: {
      type: 'string',
      enum: ['', 'minimal', 'low', 'medium', 'high'],
      default: '',
    },
    // Fotoğraf analizi için ayrı: gpt-4o gibi reasoning olmayan modeller bu alanı 400 ile reddeder.
    OPENAI_VISION_REASONING_EFFORT: {
      type: 'string',
      enum: ['', 'minimal', 'low', 'medium', 'high'],
      default: '',
    },
    AI_CHAT_MAX_OUTPUT_TOKENS: { type: 'integer', minimum: 100, default: 1200 },
    AI_CHAT_FIRST_TOKEN_MS: { type: 'integer', minimum: 1_000, default: 15_000 },
    AI_CHAT_TOTAL_MS: { type: 'integer', minimum: 5_000, default: 90_000 },
    // false: sohbet günlük kotası yok — yalnızca non-production. Üretimde false → process başlamaz.
    AI_CHAT_QUOTA_ENABLED: { type: 'boolean', default: true },

    // Abonelik: RevenueCat (docs/backend/11-abonelik.md). Paywall istemcide (RevenueCat Paywalls).
    REVENUECAT_SECRET_API_KEY: { type: 'string', default: '' },
    REVENUECAT_WEBHOOK_AUTH: { type: 'string', default: '' },
    REVENUECAT_ENTITLEMENT: { type: 'string', default: 'premium' },
    // Sandbox (TestFlight / test satın alma) premium verir mi? Üretimde varsayılan: hayır.
    REVENUECAT_ALLOW_SANDBOX: { type: 'string', enum: ['', 'true', 'false'], default: '' },

    // Push (FCM HTTP v1): Firebase servis hesabı JSON'u (ham ya da base64). Yoksa yalnızca inbox.
    FCM_SERVICE_ACCOUNT_JSON: { type: 'string', default: '' },

    SENTRY_DSN: { type: 'string', default: '' },
    SENTRY_TRACES_SAMPLE_RATE: { type: 'number', minimum: 0, maximum: 1, default: 0 },
  },
};

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Ortam değişkenlerinden doğrulanmış, dondurulmuş konfigürasyon üretir.
 * Saf fonksiyon: testlerde özel `env` ile çağrılabilir.
 */
export function loadConfig(env = process.env) {
  // env:false → yalnızca verilen `env` doğrulanır (process.env ile birleştirilmez; saf fonksiyon).
  const e = envSchema({ schema, data: env, dotenv: false, env: false });

  if (e.DOCS_ENABLED && (!e.DOCS_USER || e.DOCS_PASSWORD.length < 12)) {
    throw new Error(
      'DOCS_ENABLED=true iken DOCS_USER ve en az 12 karakterlik DOCS_PASSWORD zorunlu.',
    );
  }
  // Ağ üzerinden giden DB bağlantısı üretimde şifreli olmalı. Aynı makinedeki MySQL'e
  // (localhost) bağlanırken trafik makineden çıkmadığı için SSL gerekmez.
  if (e.NODE_ENV === 'production' && !e.DB_SSL && !LOCAL_DB_HOSTS.has(e.DB_HOST)) {
    throw new Error('Üretimde uzak MySQL için DB_SSL=true zorunlu.');
  }
  if (e.NODE_ENV === 'production' && e.DB_SSL && !e.DB_SSL_VERIFY) {
    throw new Error(
      'Üretimde DB_SSL_VERIFY=false kullanılamaz (sertifika doğrulanmalı; DB_SSL_CA verin).',
    );
  }
  // Sohbet kotası üretimde yanlışlıkla kapanmasın (yerelde AI_CHAT_QUOTA_ENABLED=false OK).
  if (e.NODE_ENV === 'production' && e.AI_CHAT_QUOTA_ENABLED === false) {
    throw new Error('Üretimde AI_CHAT_QUOTA_ENABLED=false kullanılamaz (sohbet kotası zorunlu).');
  }

  const media = mediaConfig(e);

  const config = {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    release: e.APP_RELEASE,
    server: {
      host: e.HOST,
      port: e.PORT,
      publicBaseUrl: e.PUBLIC_BASE_URL,
      trustProxy: parseTrustProxy(e.TRUST_PROXY),
      bodyLimit: e.BODY_LIMIT_BYTES,
      shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
      shutdownDrainMs: e.SHUTDOWN_DRAIN_MS,
    },
    log: { level: e.LOG_LEVEL, pretty: e.NODE_ENV === 'development' },
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      database: e.DB_NAME,
      ssl: e.DB_SSL,
      sslCa: e.DB_SSL_CA,
      sslVerify: e.DB_SSL_VERIFY,
      poolSize: e.DB_POOL_SIZE,
      slowQueryMs: e.DB_SLOW_QUERY_MS,
    },
    cache: { maxEntries: e.CACHE_MAX_ENTRIES },
    worker: { concurrency: e.WORKER_CONCURRENCY, pollMs: e.WORKER_POLL_MS },
    auth: {
      privateJwk: parseJson('JWT_PRIVATE_JWK', e.JWT_PRIVATE_JWK),
      publicJwks: parseJson('JWT_PUBLIC_JWKS', e.JWT_PUBLIC_JWKS),
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
      accessTtlSec: e.JWT_ACCESS_TTL_SEC,
      refreshTtlDays: e.REFRESH_TTL_DAYS,
      refreshAbsoluteDays: e.REFRESH_ABSOLUTE_DAYS,
      adminAudience: e.JWT_ADMIN_AUDIENCE,
      adminTtlSec: e.ADMIN_TOKEN_TTL_SEC,
    },
    admin: { ipAllowlist: splitList(e.ADMIN_IP_ALLOWLIST), allowAnyIp: e.ADMIN_ALLOW_ANY_IP },
    fieldEncryption: {
      keys: parseJson('FIELD_ENCRYPTION_KEYS_JSON', e.FIELD_ENCRYPTION_KEYS_JSON),
      activeKid: e.FIELD_ENCRYPTION_ACTIVE_KID,
    },
    firebase: {
      projectId: e.FIREBASE_PROJECT_ID,
      allowedProviders: splitList(e.FIREBASE_SIGN_IN_PROVIDERS),
    },
    cors: { origins: splitList(e.CORS_ORIGINS) },
    rateLimit: { globalMax: e.RATE_LIMIT_GLOBAL_MAX, window: e.RATE_LIMIT_WINDOW },
    metrics: {
      enabled: e.METRICS_ENABLED,
      host: e.METRICS_HOST,
      port: e.METRICS_PORT,
      workerPort: e.METRICS_WORKER_PORT,
    },
    docs: { enabled: e.DOCS_ENABLED, user: e.DOCS_USER, password: e.DOCS_PASSWORD },
    sentry: { dsn: e.SENTRY_DSN, tracesSampleRate: e.SENTRY_TRACES_SAMPLE_RATE },
    media,
    ai: {
      apiKey: e.OPENAI_API_KEY,
      enabled: e.OPENAI_API_KEY.length > 0 && e.OPENAI_VISION_MODEL.length > 0,
      visionModel: e.OPENAI_VISION_MODEL,
      reasoningEffort: e.OPENAI_VISION_REASONING_EFFORT || null,
      analysisTimeoutMs: e.AI_ANALYSIS_TIMEOUT_MS,
    },
    push: { serviceAccount: parseServiceAccountSafe(e.FCM_SERVICE_ACCOUNT_JSON) },
    billing: {
      secretApiKey: e.REVENUECAT_SECRET_API_KEY,
      webhookAuth: e.REVENUECAT_WEBHOOK_AUTH,
      entitlement: e.REVENUECAT_ENTITLEMENT,
      enabled: e.REVENUECAT_SECRET_API_KEY.length > 0,
      allowSandbox:
        e.REVENUECAT_ALLOW_SANDBOX === ''
          ? e.NODE_ENV !== 'production'
          : e.REVENUECAT_ALLOW_SANDBOX === 'true',
    },
    chatAi: {
      apiKey: e.OPENAI_API_KEY,
      model: e.OPENAI_CHAT_MODEL,
      enabled: e.OPENAI_API_KEY.length > 0 && e.OPENAI_CHAT_MODEL.length > 0,
      reasoningEffort: e.OPENAI_REASONING_EFFORT || null,
      maxOutputTokens: e.AI_CHAT_MAX_OUTPUT_TOKENS,
      firstTokenMs: e.AI_CHAT_FIRST_TOKEN_MS,
      totalMs: e.AI_CHAT_TOTAL_MS,
      quotaEnabled: e.AI_CHAT_QUOTA_ENABLED,
    },
  };
  return deepFreeze(config);
}

/** Geliştirme/test için sabit yol sırrı (üretimde kullanılamaz). */
const DEV_MEDIA_PATH_SECRET = 'dev-only-media-path-secret-not-for-production!';

/**
 * Medya ayarları. Tek Bunny zone'u (mochifast): uygulama görselleri, avatar ve kullanıcı
 * fotoğrafları aynı zone'da, token'sız. `BUNNY_PRIVATE_*` verilmezse "private" dosyalar
 * (`u/<ownerKey>/…`) de bu zone'a yazılır; yolları MEDIA_PATH_SECRET'tan türetilir, tahmin
 * edilemez. Ayrı bir token korumalı zone istenirse `BUNNY_PRIVATE_*` ile verilebilir.
 */
function mediaConfig(e) {
  const prod = e.NODE_ENV === 'production';
  if (prod && e.MEDIA_DRIVER !== 'bunny') throw new Error('Üretimde MEDIA_DRIVER=bunny zorunlu.');
  if (prod && e.MEDIA_PATH_SECRET.length < 32) {
    throw new Error('Üretimde en az 32 karakterlik MEDIA_PATH_SECRET zorunlu.');
  }
  if (e.MEDIA_DRIVER === 'bunny') {
    const missing = ['BUNNY_STORAGE_ZONE', 'BUNNY_STORAGE_PASSWORD', 'BUNNY_PULL_ZONE_HOST'].filter(
      (k) => !e[k],
    );
    if (missing.length > 0) {
      throw new Error(`MEDIA_DRIVER=bunny için eksik: ${missing.join(', ')}`);
    }
  }
  const separatePrivate = Boolean(e.BUNNY_PRIVATE_STORAGE_ZONE);
  return {
    driver: e.MEDIA_DRIVER,
    localDir: e.MEDIA_LOCAL_DIR,
    pathSecret: e.MEDIA_PATH_SECRET || DEV_MEDIA_PATH_SECRET,
    uploadMaxBytes: e.MEDIA_UPLOAD_MAX_BYTES,
    urlTtlSec: e.MEDIA_URL_TTL_SEC,
    publicZone: {
      zone: e.BUNNY_STORAGE_ZONE,
      password: e.BUNNY_STORAGE_PASSWORD,
      storageHost: e.BUNNY_STORAGE_HOST,
      pullHost: e.BUNNY_PULL_ZONE_HOST,
    },
    privateZone: {
      zone: separatePrivate ? e.BUNNY_PRIVATE_STORAGE_ZONE : e.BUNNY_STORAGE_ZONE,
      password: separatePrivate ? e.BUNNY_PRIVATE_STORAGE_PASSWORD : e.BUNNY_STORAGE_PASSWORD,
      storageHost: separatePrivate ? e.BUNNY_PRIVATE_STORAGE_HOST : e.BUNNY_STORAGE_HOST,
      pullHost: separatePrivate ? e.BUNNY_PRIVATE_PULL_ZONE_HOST : e.BUNNY_PULL_ZONE_HOST,
      // local sürücüde de imza aynı algoritmayla atılır (anahtar yoksa yol sırrından).
      tokenKey: e.BUNNY_TOKEN_AUTH_KEY || e.MEDIA_PATH_SECRET || DEV_MEDIA_PATH_SECRET,
    },
    apiKey: e.BUNNY_API_KEY,
  };
}

/** FCM servis hesabı: ham JSON ya da base64 JSON. Bozuksa başlamaz (sessizce push kapanmasın). */
function parseServiceAccountSafe(value) {
  if (!value) return null;
  try {
    const text = value.trim().startsWith('{')
      ? value
      : Buffer.from(value, 'base64').toString('utf8');
    return JSON.parse(text);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON geçerli JSON (ya da base64 JSON) değil');
  }
}

function parseTrustProxy(value) {
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  throw new Error(`TRUST_PROXY geçersiz: "${value}" (true | false | hop sayısı)`);
}

function parseJson(name, value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} geçerli JSON değil`);
  }
}

function splitList(value) {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}
