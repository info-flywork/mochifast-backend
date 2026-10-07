import { envelope, isoDateTimeSchema, uuidSchema } from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' };

const exportSchema = {
  type: 'object',
  required: ['id', 'status', 'requestedAt', 'completedAt', 'expiresAt', 'bytes', 'url'],
  properties: {
    id: uuidSchema,
    status: { type: 'string', enum: ['queued', 'processing', 'ready', 'expired', 'failed'] },
    requestedAt: isoDateTimeSchema,
    completedAt: nullableDateTime,
    expiresAt: nullableDateTime,
    bytes: { type: ['integer', 'null'] },
    // Yalnızca hazırken; kısa ömürlü imzalı link (her GET'te yenisi).
    url: { type: ['string', 'null'] },
    urlExpiresAt: nullableDateTime,
  },
};

const exportResult = envelope({
  type: 'object',
  required: ['export'],
  properties: { export: exportSchema },
});

export const deleteAccountSchema = {
  tags: ['user'],
  summary: 'Hesap silme talebi (7 gün sonra kalıcı silinir)',
  description:
    'Oturumlar hemen kapanır, hesap `pending_deletion` olur. Süre içinde Apple/Google ile tekrar giriş yapan kullanıcıya 409 ACCOUNT_PENDING_DELETION döner; `restoreAccount: true` ile hesap geri açılır. Mağaza aboneliği uygulamadan iptal edilemez (`hasActiveSubscription`).',
  security: bearer,
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: { reason: { type: 'string', maxLength: 255 } },
  },
  response: {
    202: envelope({
      type: 'object',
      required: ['scheduledFor', 'hasActiveSubscription'],
      properties: {
        scheduledFor: isoDateTimeSchema,
        hasActiveSubscription: { type: 'boolean' },
      },
    }),
  },
};

export const requestExportSchema = {
  tags: ['user'],
  summary: 'Veri dışa aktarma (zip; günde 1, 7 gün saklanır)',
  description:
    'Son 24 saatte talep varsa o döner. Hazır olunca `data_export_ready` bildirimi gelir (`params.exportId`).',
  security: bearer,
  response: { 202: exportResult },
};

export const getExportSchema = {
  tags: ['user'],
  summary: 'Dışa aktarma durumu ve indirme linki',
  security: bearer,
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: uuidSchema },
  },
  response: { 200: exportResult },
};
