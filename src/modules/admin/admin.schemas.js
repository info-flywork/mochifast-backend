import { envelope, isoDateTimeSchema, uuidSchema } from '../../shared/schemas.js';
import { mediaSchema } from '../media/media.schemas.js';
import { ADMIN_ROLES } from './admin.permissions.js';
import { PROMO_DURATIONS } from './admin.support.js';

const bearer = [{ bearerAuth: [] }];
const tags = ['admin'];
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };
const empty = envelope({ type: 'object' });
const anyObject = { type: 'object', additionalProperties: true };
const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: uuidSchema },
};
const reason = { type: 'string', minLength: 3, maxLength: 255 };
const SECTIONS = ['content', 'gamification', 'notifications', 'plans', 'labels'];
const sectionParams = {
  type: 'object',
  required: ['section'],
  properties: { section: { type: 'string', enum: SECTIONS } },
};

const adminSchema = {
  type: 'object',
  required: ['id', 'email', 'role', 'isActive', 'lastLoginAt', 'createdAt'],
  properties: {
    id: uuidSchema,
    email: { type: 'string' },
    role: { type: 'string', enum: ADMIN_ROLES },
    isActive: { type: 'boolean' },
    lastLoginAt: nullableDateTime,
    createdAt: isoDateTimeSchema,
  },
};

/** Geçici şifre + TOTP kurulumu: yalnızca oluşturma/sıfırlama yanıtında bir kez döner. */
const credentialsResult = envelope({
  type: 'object',
  required: ['admin', 'password', 'totp'],
  properties: {
    admin: adminSchema,
    password: { type: 'string' },
    totp: {
      type: 'object',
      required: ['secret', 'otpauthUrl'],
      properties: { secret: { type: 'string' }, otpauthUrl: { type: 'string' } },
    },
  },
});

const docMeta = {
  version: { type: 'integer' },
  source: { type: 'string', enum: ['seed', 'admin'] },
  adminId: { type: ['string', 'null'] },
  note: { type: ['string', 'null'] },
  createdAt: isoDateTimeSchema,
};

// ── Auth ──────────────────────────────────────────────────────────────
export const loginSchema = {
  tags,
  summary: 'Yönetici girişi: e-posta + şifre + TOTP (1 saatlik token, yenileme yok)',
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'password', 'totp'],
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 255 },
      password: { type: 'string', minLength: 1, maxLength: 200 },
      totp: { type: 'string', pattern: '^\\d{6}$' },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      required: ['token', 'expiresIn', 'admin'],
      properties: {
        token: { type: 'string' },
        expiresIn: { type: 'integer' },
        admin: adminSchema,
      },
    }),
  },
};

export const meSchema = {
  tags,
  summary: 'Oturumdaki yönetici',
  security: bearer,
  response: { 200: envelope({ type: 'object', properties: { admin: adminSchema } }) },
};

export const passwordSchema = {
  tags,
  summary: 'Şifre değiştir',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['currentPassword', 'newPassword'],
    properties: {
      currentPassword: { type: 'string', minLength: 1, maxLength: 200 },
      newPassword: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
  response: { 200: empty },
};

// ── Yöneticiler ───────────────────────────────────────────────────────
export const listAdminsSchema = {
  tags,
  summary: 'Yöneticiler (owner)',
  security: bearer,
  response: {
    200: envelope({ type: 'object', properties: { items: { type: 'array', items: adminSchema } } }),
  },
};

export const createAdminSchema = {
  tags,
  summary: 'Yönetici ekle (owner): geçici şifre + TOTP kurulumu döner',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'role'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 255 },
      role: { type: 'string', enum: ADMIN_ROLES },
    },
  },
  response: { 201: credentialsResult },
};

export const updateAdminSchema = {
  tags,
  summary: 'Rol değiştir / pasifleştir (owner)',
  security: bearer,
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      role: { type: 'string', enum: ADMIN_ROLES },
      isActive: { type: 'boolean' },
    },
  },
  response: { 200: envelope({ type: 'object', properties: { admin: adminSchema } }) },
};

export const resetAdminSchema = {
  tags,
  summary: 'Şifre + TOTP sıfırla (owner)',
  security: bearer,
  params: idParams,
  response: { 200: credentialsResult },
};

// ── Katalog ───────────────────────────────────────────────────────────
export const listSectionsSchema = {
  tags,
  summary: 'Katalog bölümleri ve güncel sürümleri',
  security: bearer,
  response: {
    200: envelope({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              section: { type: 'string' },
              current: { type: ['object', 'null'], properties: docMeta },
            },
          },
        },
      },
    }),
  },
};

const sectionDoc = envelope({
  type: 'object',
  properties: {
    section: { type: 'string' },
    ...docMeta,
    document: {},
  },
});

export const getSectionSchema = {
  tags,
  summary: 'Bölüm dokümanı (seed biçimi: çeviriler dahil)',
  security: bearer,
  params: sectionParams,
  response: { 200: sectionDoc },
};

export const listVersionsSchema = {
  tags,
  summary: 'Bölüm sürüm geçmişi',
  security: bearer,
  params: sectionParams,
  response: {
    200: envelope({
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: docMeta } } },
    }),
  },
};

export const getVersionSchema = {
  tags,
  summary: 'Bölümün eski bir sürümü',
  security: bearer,
  params: {
    type: 'object',
    required: ['section', 'version'],
    properties: { ...sectionParams.properties, version: { type: 'integer', minimum: 1 } },
  },
  response: { 200: sectionDoc },
};

const applyResult = envelope({
  type: 'object',
  properties: {
    version: { type: 'integer' },
    catalogVersion: { type: 'integer' },
    stats: anyObject,
  },
});

export const saveSectionSchema = {
  tags,
  summary: 'Bölümü kaydet (tamamı; arada başkası kaydettiyse 409)',
  description:
    'Doküman seed dosyasıyla aynı biçimdedir. Tek transaction: hata olursa hiçbir şey değişmez (400). Kaydedilen bölümü `npm run seed` artık ezmez.',
  security: bearer,
  params: sectionParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['document', 'baseVersion'],
    properties: {
      document: { type: ['object', 'array'] },
      baseVersion: { type: 'integer', minimum: 0 },
      note: { type: 'string', maxLength: 255 },
    },
  },
  response: { 200: applyResult },
};

export const rollbackSchema = {
  tags,
  summary: 'Eski sürümü yeni sürüm olarak uygula',
  security: bearer,
  params: sectionParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['version'],
    properties: {
      version: { type: 'integer', minimum: 1 },
      note: { type: 'string', maxLength: 255 },
    },
  },
  response: { 200: applyResult },
};

// ── app_config ────────────────────────────────────────────────────────
const configList = envelope({
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          platform: { type: 'string' },
          value: {},
          description: { type: ['string', 'null'] },
          protected: { type: 'boolean' },
          updatedAt: isoDateTimeSchema,
        },
      },
    },
  },
});
const configKeyParams = {
  type: 'object',
  required: ['key'],
  properties: { key: { type: 'string', pattern: '^[a-z][a-z0-9_.]{1,79}$' } },
};
const platform = { type: 'string', enum: ['all', 'ios', 'android'] };

export const listConfigSchema = {
  tags,
  summary: 'Uygulama yapılandırması (app_config)',
  security: bearer,
  response: { 200: configList },
};

export const setConfigSchema = {
  tags,
  summary: 'Yapılandırma değeri yaz (platforma özel değer "all"ı ezer)',
  security: bearer,
  params: configKeyParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { platform, value: {}, description: { type: 'string', maxLength: 255 } },
  },
  response: { 200: configList },
};

export const deleteConfigSchema = {
  tags,
  summary: 'Platforma özel değeri kaldır',
  security: bearer,
  params: configKeyParams,
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['platform'],
    properties: { platform: { type: 'string', enum: ['ios', 'android'] } },
  },
  response: { 200: empty },
};

// ── Medya ─────────────────────────────────────────────────────────────
export const uploadSchema = {
  tags,
  summary: 'İçerik görseli yükle (public, kalıcı URL; multipart: file)',
  security: bearer,
  consumes: ['multipart/form-data'],
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['purpose'],
    properties: {
      purpose: { type: 'string', enum: ['insightCover', 'challengeImage', 'planImage'] },
    },
  },
  response: { 201: envelope({ type: 'object', properties: { media: mediaSchema } }) },
};

// ── Kullanıcılar (destek) ─────────────────────────────────────────────
const userSummary = {
  type: 'object',
  properties: {
    id: uuidSchema,
    status: { type: 'string' },
    isGuest: { type: 'boolean' },
    name: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    locale: { type: 'string' },
    timezone: { type: 'string' },
    onboarded: { type: 'boolean' },
    lastActiveAt: nullableDateTime,
    createdAt: isoDateTimeSchema,
  },
};

export const searchUsersSchema = {
  tags,
  summary: 'Kullanıcı ara: kimlik (UUID) ya da tam e-posta; PII maskeli',
  security: bearer,
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['q'],
    properties: { q: { type: 'string', minLength: 3, maxLength: 255 } },
  },
  response: {
    200: envelope({ type: 'object', properties: { items: { type: 'array', items: userSummary } } }),
  },
};

export const userDetailSchema = {
  tags,
  summary: 'Kullanıcı ayrıntısı (destek; sağlık verisi yok)',
  security: bearer,
  params: idParams,
  response: {
    200: envelope({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            ...userSummary.properties,
            isPremium: { type: 'boolean' },
            devices: { type: 'array', items: anyObject },
            activeSessions: { type: 'integer' },
            subscription: { type: ['object', 'null'], additionalProperties: true },
            deletion: { type: ['object', 'null'], additionalProperties: true },
            consents: { type: 'array', items: anyObject },
            stats: { type: ['object', 'null'], additionalProperties: true },
          },
        },
      },
    }),
  },
};

const withReason = (extra = {}, required = []) => ({
  type: 'object',
  additionalProperties: false,
  required: ['reason', ...required],
  properties: { reason, ...extra },
});

export const revokeSessionsSchema = {
  tags,
  summary: 'Kullanıcının tüm oturumlarını sonlandır',
  security: bearer,
  params: idParams,
  body: withReason(),
  response: { 200: empty },
};

export const grantPremiumSchema = {
  tags,
  summary: 'Promosyon premium tanımla (RevenueCat)',
  security: bearer,
  params: idParams,
  body: withReason({ duration: { type: 'string', enum: PROMO_DURATIONS } }, ['duration']),
  response: {
    200: envelope({ type: 'object', properties: { isPremium: { type: 'boolean' } } }),
  },
};

export const requestDeletionSchema = {
  tags,
  summary: 'E-postayla gelen silme talebini oluştur (7 gün bekleme, uygulamadaki gibi)',
  security: bearer,
  params: idParams,
  body: withReason(),
  response: {
    202: envelope({
      type: 'object',
      required: ['scheduledFor'],
      properties: { scheduledFor: isoDateTimeSchema },
    }),
  },
};

export const expediteDeletionSchema = {
  tags,
  summary: 'Bekleyen silme talebini hızlandır (≤ 1 saat içinde silinir)',
  security: bearer,
  params: idParams,
  body: withReason(),
  response: { 200: empty },
};

// ── Raporlar ──────────────────────────────────────────────────────────
export const overviewSchema = {
  tags,
  summary: 'Genel rapor: kayıt, DAU/WAU/MAU, huni, oruç, AI maliyeti, premium (UTC)',
  security: bearer,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
  },
  response: { 200: envelope(anyObject) },
};
