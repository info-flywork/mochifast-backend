import {
  envelope,
  localDateSchema,
  pagedEnvelope,
  pageQuerySchema,
  uuidSchema,
} from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const nstr = { type: ['string', 'null'] };
const dateTime = { type: 'string', format: 'date-time' };
const feeling = { type: 'string', enum: ['tough', 'meh', 'good', 'super'] };
const notes = { type: ['string', 'null'], maxLength: 1000 };
const weightKg = { type: 'number', minimum: 25, maximum: 350 };

export const fastSchema = {
  type: 'object',
  properties: {
    id: uuidSchema,
    status: { type: 'string' },
    planCode: nstr,
    targetMinutes: { type: 'integer' },
    startedAt: { type: 'string' },
    plannedEndAt: { type: 'string' },
    endedAt: nstr,
    durationMinutes: { type: ['integer', 'null'] },
    goalReached: { type: 'boolean' },
    localDate: { type: 'string' },
    tz: { type: 'string' },
    feeling: nstr,
    notes: nstr,
    source: { type: 'string' },
    autoClosed: { type: 'boolean' },
    elapsedMinutes: { type: 'integer' },
    progress: { type: 'number' },
    stage: {
      type: ['object', 'null'],
      properties: {
        position: { type: 'integer' },
        title: { type: 'string' },
        rangeLabel: nstr,
        imageKey: { type: 'string' },
        nextStageAt: nstr,
      },
    },
    serverTime: { type: 'string' },
  },
};

export const eatingWindowSchema = {
  type: ['object', 'null'],
  properties: {
    lastFastId: { type: 'string' },
    startedAt: { type: 'string' },
    endsAt: { type: 'string' },
    eatMinutes: { type: 'integer' },
    elapsedMinutes: { type: 'integer' },
    stage: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        title: { type: 'string' },
        position: { type: 'integer' },
      },
    },
    suggestedNextStartAt: { type: 'string' },
    serverTime: { type: 'string' },
  },
};

export const weekDaySchema = {
  type: 'object',
  properties: {
    date: { type: 'string' },
    dayType: { type: 'string', enum: ['fast', 'reduced', 'normal'] },
    isRequiredDay: { type: 'boolean' },
    goalMinutes: { type: ['integer', 'null'] },
    fastedMinutes: { type: 'integer' },
    progress: { type: ['number', 'null'] },
    checkin: nstr,
    kept: { type: ['boolean', 'null'] },
    isToday: { type: 'boolean' },
    isFuture: { type: 'boolean' },
  },
};

const fastResponse = (extra = {}) =>
  envelope({ type: 'object', required: ['fast'], properties: { fast: fastSchema, ...extra } });

const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: uuidSchema },
};

export const activeSchema = {
  tags: ['fasts'],
  summary: 'Aktif oruç (canlı süre, ilerleme, evre) ya da yeme penceresi',
  security: bearer,
  response: {
    200: envelope({
      type: 'object',
      required: ['fast', 'eatingWindow'],
      properties: {
        fast: { ...fastSchema, type: ['object', 'null'] },
        eatingWindow: eatingWindowSchema,
      },
    }),
  },
};

export const startSchema = {
  tags: ['fasts'],
  summary: 'Oruç başlat (idempotent: istemci id ya da Idempotency-Key)',
  security: bearer,
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: {
      id: uuidSchema,
      startedAt: dateTime,
      targetMinutes: { type: 'integer', minimum: 60, maximum: 4320 },
      source: { type: 'string', enum: ['app', 'widget'] },
    },
  },
  response: { 200: fastResponse(), 201: fastResponse() },
};

export const finishSchema = {
  tags: ['fasts'],
  summary: 'Orucu bitir',
  security: bearer,
  params: idParams,
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: { endedAt: dateTime, startedAt: dateTime, feeling, notes, weightKg },
  },
  response: {
    200: fastResponse({
      isFirstFast: { type: 'boolean' },
      warnings: { type: 'array', items: { type: 'string' } },
      streak: {
        type: 'object',
        properties: {
          current: { type: 'integer' },
          best: { type: 'integer' },
          increased: { type: 'boolean' },
        },
      },
      xpGained: { type: 'integer' },
      levelUp: {
        type: ['object', 'null'],
        properties: { from: { type: 'integer' }, to: { type: 'integer' } },
      },
      world: {
        type: 'object',
        properties: {
          health: { type: 'string' },
          levelUps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                zone: { type: 'string' },
                from: { type: 'integer' },
                to: { type: 'integer' },
              },
            },
          },
        },
      },
      challenges: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            progress: { type: 'integer' },
            target: { type: 'integer' },
            status: { type: 'string' },
          },
        },
      },
    }),
  },
};

export const cancelSchema = {
  tags: ['fasts'],
  summary: 'Orucu iptal et (10 dk içinde iz bırakmaz)',
  security: bearer,
  params: idParams,
  response: {
    200: envelope({ type: 'object', properties: { id: uuidSchema, deleted: { type: 'boolean' } } }),
  },
};

export const updateSchema = {
  tags: ['fasts'],
  summary: 'Oruç düzenle',
  security: bearer,
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      startedAt: dateTime,
      endedAt: dateTime,
      targetMinutes: { type: 'integer', minimum: 60, maximum: 4320 },
      feeling: { ...feeling, type: ['string', 'null'], enum: [...feeling.enum, null] },
      notes,
    },
  },
  response: { 200: fastResponse() },
};

export const manualSchema = {
  tags: ['fasts'],
  summary: 'Geçmiş oruç kaydet',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['startedAt', 'endedAt'],
    properties: {
      startedAt: dateTime,
      endedAt: dateTime,
      targetMinutes: { type: 'integer', minimum: 60, maximum: 4320 },
      feeling,
      notes,
    },
  },
  response: { 201: fastResponse() },
};

export const removeSchema = {
  tags: ['fasts'],
  summary: 'Orucu sil (yumuşak silme)',
  security: bearer,
  params: idParams,
  response: { 200: envelope({ type: 'object', additionalProperties: false, properties: {} }) },
};

export const getSchema = {
  tags: ['fasts'],
  summary: 'Oruç detayı',
  security: bearer,
  params: idParams,
  response: { 200: fastResponse() },
};

export const listSchema = {
  tags: ['fasts'],
  summary: 'Oruç geçmişi',
  security: bearer,
  querystring: {
    ...pageQuerySchema,
    properties: {
      ...pageQuerySchema.properties,
      from: localDateSchema,
      to: localDateSchema,
      status: { type: 'string', enum: ['active', 'completed', 'endedEarly', 'cancelled'] },
    },
  },
  response: { 200: pagedEnvelope(fastSchema) },
};

export const struggleSchema = {
  tags: ['fasts'],
  summary: 'Zorlanma olayı kaydet',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: { type: 'string', enum: ['hungry', 'craving', 'energy', 'stressed', 'bored'] },
      tip: { type: 'string', enum: ['hydration', 'walk', 'breathe'] },
      tipCompleted: { type: 'boolean', default: false },
      outcome: { type: 'string', enum: ['keepGoing', 'tryAnother', 'endedFast'] },
    },
  },
  response: {
    201: envelope({
      type: 'object',
      properties: { id: uuidSchema, elapsedMinutes: { type: ['integer', 'null'] } },
    }),
  },
};

export const struggleWithFastSchema = { ...struggleSchema, params: idParams };

export const weekSchema = {
  tags: ['fasts'],
  summary: 'Hafta şeridi (Pzt–Paz)',
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
        weekStart: { type: 'string' },
        today: { type: 'string' },
        serverTime: { type: 'string' },
        days: { type: 'array', items: weekDaySchema },
      },
    }),
  },
};

export const statsTotalsSchema = {
  fasts: { type: 'integer' },
  completedFasts: { type: 'integer' },
  completionRate: { type: 'number' },
  totalFastedMinutes: { type: 'integer' },
  longestFastMinutes: { type: 'integer' },
  avgFastMinutes: { type: 'integer' },
};

export const statsSchema = {
  tags: ['fasts'],
  summary: 'Oruç toplamları ve grafik kovaları',
  security: bearer,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      range: { type: 'string', enum: ['week', 'month', 'year', 'all'], default: 'week' },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        range: { type: 'string' },
        from: nstr,
        to: { type: 'string' },
        bucketSize: { type: 'string', enum: ['day', 'month'] },
        totals: { type: 'object', properties: statsTotalsSchema },
        buckets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              month: { type: 'string' },
              fastedMinutes: { type: 'integer' },
              goalMinutes: { type: ['integer', 'null'] },
              fasts: { type: 'integer' },
            },
          },
        },
      },
    }),
  },
};
