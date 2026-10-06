import { envelope } from '../../shared/schemas.js';

const nullableNumber = { type: ['number', 'null'] };
const nullableString = { type: ['string', 'null'] };

export const planSummarySchema = {
  type: 'object',
  required: ['code', 'displayName', 'cardLabel', 'shortDescription', 'isPremium', 'isLocked'],
  properties: {
    code: { type: 'string' },
    category: { type: 'string' },
    scheduleType: { type: 'string' },
    displayName: { type: 'string' },
    cardLabel: { type: 'string' },
    shortDescription: { type: 'string' },
    fastHours: nullableNumber,
    eatHours: nullableNumber,
    reducedDaysPerWeek: { type: ['integer', 'null'] },
    reducedDayKcal: { type: ['integer', 'null'] },
    intensity: { type: 'integer' },
    isPremium: { type: 'boolean' },
    isLocked: { type: 'boolean' },
    isFeatured: { type: 'boolean' },
    requiresSafetyAck: { type: 'boolean' },
    minAge: { type: 'integer' },
    allowedTimings: { type: 'array', items: { type: 'string' } },
    defaultTiming: nullableString,
    defaultEatStart: nullableString,
  },
};

export const planCatalogSchema = {
  tags: ['catalog'],
  summary: 'Plan kataloğu (gruplar + zamanlama tercihleri)',
  description: 'Token opsiyonel: varsa premium kilidi kişiselleşir ve yanıt private olur.',
  response: {
    200: envelope({
      type: 'object',
      required: ['groups', 'timings'],
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            required: ['category', 'title', 'plans'],
            properties: {
              category: { type: 'string' },
              title: { type: 'string' },
              plans: { type: 'array', items: planSummarySchema },
            },
          },
        },
        timings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['code', 'title'],
            properties: { code: { type: 'string' }, title: { type: 'string' } },
          },
        },
      },
    }),
  },
};

export const planDetailSchema = {
  tags: ['catalog'],
  summary: 'Plan detayı',
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['code'],
    properties: { code: { type: 'string', pattern: '^[a-z0-9_]{2,32}$' } },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        ...planSummarySchema.properties,
        longDescription: nullableString,
        safetyNote: nullableString,
        exampleWindow: {
          type: ['object', 'null'],
          properties: { start: { type: 'string' }, end: { type: 'string' } },
        },
        weeklyTemplate: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            properties: {
              dow: { type: 'integer' },
              type: { type: 'string' },
              kcal: { type: 'integer' },
              fastMinutes: { type: 'integer' },
            },
          },
        },
      },
    }),
  },
};
