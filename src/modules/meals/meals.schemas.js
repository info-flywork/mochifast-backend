import {
  envelope,
  localDateSchema,
  pagedEnvelope,
  pageQuerySchema,
  uuidSchema,
} from '../../shared/schemas.js';
import { mediaSchema } from '../media/media.schemas.js';

const bearer = [{ bearerAuth: [] }];
const dateTime = { type: 'string', format: 'date-time' };
const nstr = { type: ['string', 'null'] };
const nnum = { type: ['number', 'null'] };
const nint = { type: ['integer', 'null'] };
const enumOrNull = (values) => ({ type: ['string', 'null'], enum: [...values, null] });

const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: uuidSchema },
};

const editable = {
  kind: enumOrNull(['meal', 'snack']),
  slot: enumOrNull(['breakfast', 'lunch', 'dinner', 'snack']),
  dietType: enumOrNull(['ketogenic', 'lowCarb', 'mixed', 'highCarb', 'notSure']),
  feeling: enumOrNull(['meh', 'good', 'super']),
  title: { type: ['string', 'null'], maxLength: 120 },
  notes: { type: ['string', 'null'], maxLength: 1000 },
  kcal: { type: ['integer', 'null'], minimum: 0, maximum: 10_000 },
  proteinG: { type: ['number', 'null'], minimum: 0, maximum: 1000 },
  carbsG: { type: ['number', 'null'], minimum: 0, maximum: 2000 },
  fatG: { type: ['number', 'null'], minimum: 0, maximum: 1000 },
  // POST /v1/media ile yüklenmiş kendi öğün fotoğrafı; null bağlantıyı kaldırır.
  photoMediaId: { type: ['string', 'null'], format: 'uuid' },
};

export const mealSchema = {
  type: 'object',
  properties: {
    id: uuidSchema,
    eatenAt: { type: 'string' },
    localDate: { type: 'string' },
    kind: nstr,
    slot: nstr,
    dietType: nstr,
    feeling: nstr,
    title: nstr,
    notes: nstr,
    kcal: nint,
    proteinG: nnum,
    carbsG: nnum,
    fatG: nnum,
    source: { type: 'string' },
    breaksFastId: nstr,
    photo: mediaSchema,
  },
};
const mealResponse = (extra = {}) =>
  envelope({ type: 'object', properties: { meal: mealSchema, ...extra } });

const createResponse = mealResponse({
  activeFastId: nstr,
  suggestEndFast: { type: 'boolean' },
});

export const mealCreateSchema = {
  tags: ['meals'],
  summary: 'Öğün kaydı (aktif oruçta "orucu bitir?" önerisi)',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: uuidSchema,
      eatenAt: dateTime,
      // aiPhoto F6'da (fotoğraf analizi) açılır.
      source: { type: 'string', enum: ['manual', 'quickKcal'] },
      ...editable,
    },
  },
  response: { 200: createResponse, 201: createResponse },
};

export const mealUpdateSchema = {
  tags: ['meals'],
  summary: 'Öğünü düzenle',
  security: bearer,
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: { eatenAt: dateTime, ...editable },
  },
  response: { 200: mealResponse() },
};

export const mealGetSchema = {
  tags: ['meals'],
  summary: 'Öğün detayı',
  security: bearer,
  params: idParams,
  response: { 200: mealResponse() },
};

export const mealDeleteSchema = {
  tags: ['meals'],
  summary: 'Öğünü sil',
  security: bearer,
  params: idParams,
  response: { 200: envelope({ type: 'object' }) },
};

export const mealListSchema = {
  tags: ['meals'],
  summary: 'Öğünler (date: günün zaman çizelgesi; yoksa sayfalı geçmiş)',
  security: bearer,
  querystring: {
    ...pageQuerySchema,
    properties: {
      ...pageQuerySchema.properties,
      date: localDateSchema,
      from: localDateSchema,
      to: localDateSchema,
    },
  },
  response: { 200: pagedEnvelope(mealSchema) },
};

const macro = {
  type: 'object',
  properties: { g: { type: 'number' }, goalG: nint, progress: nnum },
};

export const nutritionDaySchema = {
  tags: ['nutrition'],
  summary: 'Günün beslenmesi (kalori, makrolar, öğünler)',
  security: bearer,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { date: localDateSchema },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        date: { type: 'string' },
        kcal: { type: 'integer' },
        kcalGoal: nint,
        progress: nnum,
        overKcal: nint,
        burnedKcal: { type: 'integer' },
        macros: {
          type: 'object',
          properties: { protein: macro, carbs: macro, fat: macro },
        },
        meals: { type: 'array', items: mealSchema },
      },
    }),
  },
};

export const nutritionWeekSchema = {
  tags: ['nutrition'],
  summary: 'Haftalık kalori ya da protein (Pzt–Paz)',
  security: bearer,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      date: localDateSchema,
      metric: { type: 'string', enum: ['kcal', 'protein'], default: 'kcal' },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        metric: { type: 'string' },
        weekStart: { type: 'string' },
        goal: nint,
        days: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              value: { type: 'number' },
              progress: nnum,
              isToday: { type: 'boolean' },
              isFuture: { type: 'boolean' },
            },
          },
        },
      },
    }),
  },
};
