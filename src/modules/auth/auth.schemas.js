import { PLATFORMS, SUPPORTED_LOCALES } from '../../config/constants.js';
import { envelope, pagedEnvelope, uuidSchema } from '../../shared/schemas.js';

const platform = { type: 'string', enum: PLATFORMS };
const locale = { type: 'string', enum: SUPPORTED_LOCALES };
const timezone = { type: 'string', minLength: 1, maxLength: 64 };
const shortText = (max) => ({ type: 'string', minLength: 1, maxLength: max });

export const tokenPairSchema = {
  type: 'object',
  required: ['accessToken', 'refreshToken', 'expiresIn'],
  properties: {
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
    expiresIn: { type: 'integer' },
  },
};

export const authUserSchema = {
  type: 'object',
  required: ['id', 'name', 'email', 'isGuest', 'isPremium', 'isAnsweredQuestions'],
  properties: {
    id: uuidSchema,
    name: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    isGuest: { type: 'boolean' },
    isPremium: { type: 'boolean' },
    isAnsweredQuestions: { type: 'boolean' },
  },
};

const authResult = (extra = {}) =>
  envelope({
    type: 'object',
    required: ['token', 'user', ...Object.keys(extra)],
    properties: { token: tokenPairSchema, user: authUserSchema, ...extra },
  });

export const guestSchema = {
  tags: ['auth'],
  summary: 'Misafir oturumu (onboarding başında)',
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['installId', 'platform'],
    properties: {
      installId: uuidSchema,
      platform,
      locale,
      timezone,
      appVersion: shortText(32),
      osVersion: shortText(32),
      deviceModel: shortText(64),
    },
  },
  response: { 200: authResult(), 201: authResult() },
};

const registerResult = authResult({
  isNewUser: { type: 'boolean' },
  linkedFromGuest: { type: 'boolean' },
  mergedFromGuest: { type: 'boolean' },
});

export const registerSchema = {
  tags: ['auth'],
  summary: 'Apple/Google ile giriş, kayıt veya misafir yükseltme',
  description:
    'Authorization header’ında misafir oturumu varsa hesap yükseltilir. Sosyal kimlik başka bir hesaba bağlıysa 409 ACCOUNT_LINK_CONFLICT; tekrar `mergeGuest: false` (hesaba geç) ya da `true` (misafir verisini taşı) ile çağrılır.',
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['provider'],
    properties: {
      provider: { type: 'string', enum: ['apple', 'google', 'guest'] },
      idToken: shortText(8192),
      authorizationCode: shortText(1024),
      nonce: shortText(256),
      fullName: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          givenName: { type: ['string', 'null'], maxLength: 60 },
          familyName: { type: ['string', 'null'], maxLength: 60 },
        },
      },
      deviceId: uuidSchema,
      platform,
      locale,
      timezone,
      mergeGuest: { type: 'boolean' },
    },
  },
  response: { 200: registerResult, 201: registerResult },
};

export const refreshSchema = {
  tags: ['auth'],
  summary: 'Refresh token rotasyonu',
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['refreshToken'],
    properties: { refreshToken: { type: 'string', pattern: '^rt_[A-Za-z0-9_-]{43}$' } },
  },
  response: {
    200: envelope({ type: 'object', required: ['token'], properties: { token: tokenPairSchema } }),
  },
};

const emptyData = envelope({ type: 'object', additionalProperties: false, properties: {} });

export const logoutSchema = {
  tags: ['auth'],
  summary: 'Çıkış (bu cihaz ya da tüm cihazlar)',
  security: [{ bearerAuth: [] }],
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: {
      // Geriye uyumluluk için kabul edilir; oturum access token'dan belirlenir.
      refreshToken: { type: 'string', maxLength: 64 },
      allDevices: { type: 'boolean', default: false },
    },
  },
  response: { 200: emptyData },
};

export const listSessionsSchema = {
  tags: ['auth'],
  summary: 'Aktif oturumlar',
  security: [{ bearerAuth: [] }],
  response: {
    200: pagedEnvelope({
      type: 'object',
      required: [
        'id',
        'platform',
        'deviceModel',
        'appVersion',
        'signedInAt',
        'lastUsedAt',
        'current',
      ],
      properties: {
        id: uuidSchema,
        platform: { type: ['string', 'null'] },
        deviceModel: { type: ['string', 'null'] },
        appVersion: { type: ['string', 'null'] },
        signedInAt: { type: 'string', format: 'date-time' },
        lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
        current: { type: 'boolean' },
      },
    }),
  },
};

export const revokeSessionSchema = {
  tags: ['auth'],
  summary: 'Bir oturumu uzaktan kapat',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: uuidSchema },
  },
  response: { 200: emptyData },
};
