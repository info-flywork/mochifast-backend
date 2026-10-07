import { envelope, uuidSchema } from '../../shared/schemas.js';
import { mediaSchema } from '../media/media.schemas.js';

const bearer = [{ bearerAuth: [] }];
const nstr = { type: ['string', 'null'] };

const item = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    portion: { type: 'string' },
    kcal: { type: 'integer' },
    proteinG: { type: 'number' },
    carbsG: { type: 'number' },
    fatG: { type: 'number' },
  },
};

export const analysisSchema = {
  type: 'object',
  properties: {
    id: uuidSchema,
    status: { type: 'string', enum: ['queued', 'processing', 'succeeded', 'notFood', 'failed'] },
    photo: mediaSchema,
    result: {
      type: ['object', 'null'],
      properties: {
        mealTitle: { type: 'string' },
        items: { type: 'array', items: item },
        kcal: { type: 'integer' },
        proteinG: { type: 'number' },
        carbsG: { type: 'number' },
        fatG: { type: 'number' },
        confidence: { type: 'number' },
        notes: { type: 'string' },
        flags: { type: 'array', items: { type: 'string' } },
      },
    },
    error: { type: ['object', 'null'], properties: { code: { type: 'string' } } },
    createdAt: { type: 'string' },
    completedAt: nstr,
  },
};

export const submitSchema = {
  tags: ['meals'],
  summary: 'Fotoğraftan öğün analizi başlat (multipart: file) → 202, yokla',
  security: bearer,
  consumes: ['multipart/form-data'],
  response: {
    202: envelope({
      type: 'object',
      properties: {
        analysisId: uuidSchema,
        status: { type: 'string' },
        pollAfterMs: { type: 'integer' },
      },
    }),
  },
};

export const getAnalysisSchema = {
  tags: ['meals'],
  summary: 'Analiz durumu ve sonucu',
  security: bearer,
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: uuidSchema },
  },
  response: { 200: envelope({ type: 'object', properties: { analysis: analysisSchema } }) },
};

const quotaEntry = {
  type: 'object',
  properties: {
    used: { type: 'integer' },
    limit: { type: 'integer' },
    remaining: { type: 'integer' },
    resetAt: { type: 'string' },
  },
};

export const quotaSchema = {
  tags: ['chat'],
  summary: 'Günlük AI kotaları (sohbet, fotoğraf analizi)',
  security: bearer,
  response: {
    200: envelope({
      type: 'object',
      properties: { chat: quotaEntry, photoAnalysis: quotaEntry, isPremium: { type: 'boolean' } },
    }),
  },
};
