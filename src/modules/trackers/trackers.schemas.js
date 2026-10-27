import {
  envelope,
  localDateSchema,
  pagedEnvelope,
  pageQuerySchema,
  uuidSchema,
} from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const dateTime = { type: 'string', format: 'date-time' };
const nnum = { type: ['number', 'null'] };
const nint = { type: ['integer', 'null'] };
const nstr = { type: ['string', 'null'] };
const weightKg = { type: 'number', minimum: 25, maximum: 350 };
const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: uuidSchema },
};
const dateQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { date: localDateSchema },
};
const warnings = { type: 'array', items: { type: 'string' } };
const healthSource = { type: 'string', enum: ['appleHealth', 'googleFit'] };

// ── Kilo ──────────────────────────────────────────────────────────────
const weightEntry = {
  type: 'object',
  properties: {
    id: uuidSchema,
    weightKg: { type: 'number' },
    recordedAt: { type: 'string' },
    localDate: { type: 'string' },
    source: { type: 'string' },
  },
};
const weightResponse = envelope({ type: 'object', properties: { entry: weightEntry } });

export const weightCreateSchema = {
  tags: ['weights'],
  summary: 'Kilo kaydı',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['weightKg'],
    properties: { id: uuidSchema, weightKg, recordedAt: dateTime },
  },
  response: { 200: weightResponse, 201: weightResponse },
};

export const weightUpdateSchema = {
  tags: ['weights'],
  summary: 'Kilo kaydını düzenle',
  security: bearer,
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: { weightKg, recordedAt: dateTime },
  },
  response: { 200: weightResponse },
};

export const weightDeleteSchema = {
  tags: ['weights'],
  summary: 'Kilo kaydını sil',
  security: bearer,
  params: idParams,
  response: { 200: envelope({ type: 'object' }) },
};

export const weightListSchema = {
  tags: ['weights'],
  summary: 'Kilo kayıtları (yeniden eskiye)',
  security: bearer,
  querystring: {
    ...pageQuerySchema,
    properties: { ...pageQuerySchema.properties, from: localDateSchema, to: localDateSchema },
  },
  response: { 200: pagedEnvelope(weightEntry) },
};

export const weightChartSchema = {
  tags: ['weights'],
  summary: 'Kilo grafiği (7 kova, dinamik Y ekseni)',
  security: bearer,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { range: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' } },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        range: { type: 'string' },
        goalKg: nnum,
        yAxis: {
          type: ['object', 'null'],
          properties: { min: { type: 'number' }, max: { type: 'number' } },
        },
        buckets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              weightKg: nnum,
            },
          },
        },
      },
    }),
  },
};

const weightSummary = {
  type: 'object',
  properties: {
    currentKg: nnum,
    startKg: nnum,
    goalKg: nnum,
    progress: nnum,
    changeKg: nnum,
    bmi: nnum,
    bmiCategory: nstr,
    bmiBand: nstr,
    heightCm: nnum,
    targetDate: nstr,
    warnings,
  },
};

export const weightSummarySchema = {
  tags: ['weights'],
  summary: 'Kilo özeti (BMI, ilerleme, hedef tarihi)',
  security: bearer,
  response: { 200: envelope(weightSummary) },
};

export const weightGoalSchema = {
  tags: ['weights'],
  summary: 'Hedef kilo (profil alanı)',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['goalWeightKg'],
    properties: { goalWeightKg: weightKg },
  },
  response: { 200: envelope(weightSummary) },
};

// ── Su ────────────────────────────────────────────────────────────────
const waterDay = {
  type: 'object',
  properties: {
    date: { type: 'string' },
    totalMl: { type: 'integer' },
    goalMl: { type: 'integer' },
    progress: { type: 'number' },
    goalReached: { type: 'boolean' },
    glassSizeMl: { type: 'integer' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: uuidSchema,
          amountMl: { type: 'integer' },
          loggedAt: { type: 'string' },
          source: { type: 'string' },
        },
      },
    },
    warnings,
  },
};

export const waterDaySchema = {
  tags: ['water'],
  summary: 'Günün suyu',
  security: bearer,
  querystring: dateQuery,
  response: { 200: envelope(waterDay) },
};

export const waterAddSchema = {
  tags: ['water'],
  summary: 'Su ekle (yanıt: güncel gün)',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['amountMl'],
    properties: {
      id: uuidSchema,
      amountMl: { type: 'integer', minimum: 1, maximum: 5000 },
      loggedAt: dateTime,
      source: { type: 'string', enum: ['app', 'widget'] },
    },
  },
  response: { 200: envelope(waterDay), 201: envelope(waterDay) },
};

export const waterDeleteSchema = {
  tags: ['water'],
  summary: 'Su kaydını geri al',
  security: bearer,
  params: idParams,
  response: { 200: envelope(waterDay) },
};

export const waterWeekSchema = {
  tags: ['water'],
  summary: 'Haftalık su (Pzt–Paz)',
  security: bearer,
  querystring: dateQuery,
  response: {
    200: envelope({
      type: 'object',
      properties: {
        weekStart: { type: 'string' },
        days: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              totalMl: { type: 'integer' },
              goalMl: { type: 'integer' },
              progress: { type: 'number' },
              goalReached: { type: 'boolean' },
              isToday: { type: 'boolean' },
              isFuture: { type: 'boolean' },
            },
          },
        },
      },
    }),
  },
};

// ── Adım ──────────────────────────────────────────────────────────────
const stepsList = {
  type: 'object',
  properties: {
    range: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    goal: { type: 'integer' },
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          steps: { type: 'integer' },
          distanceKm: { type: 'number' },
          kcal: { type: 'integer' },
          durationMin: { type: 'integer' },
          progress: { type: 'number' },
          source: nstr,
          isFuture: { type: 'boolean' },
        },
      },
    },
  },
};
const stepCount = { type: 'integer', minimum: 0, maximum: 200_000 };

export const stepsPutSchema = {
  tags: ['steps'],
  summary: 'Günün adımı (manuel)',
  security: bearer,
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['date'],
    properties: { date: localDateSchema },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['steps'],
    properties: { steps: stepCount, source: { type: 'string', enum: ['manual'] } },
  },
  response: { 200: envelope(stepsList) },
};

export const stepsSyncSchema = {
  tags: ['steps'],
  summary: 'Sağlık uygulamasından toplu adım aktarımı',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'days'],
    properties: {
      source: healthSource,
      days: {
        type: 'array',
        minItems: 1,
        maxItems: 31,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['date', 'steps'],
          properties: {
            date: localDateSchema,
            steps: stepCount,
            distanceM: { type: 'integer', minimum: 0, maximum: 500_000 },
            activeKcal: { type: 'integer', minimum: 0, maximum: 20_000 },
          },
        },
      },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: { updated: { type: 'integer' }, skipped: { type: 'integer' } },
    }),
  },
};

export const stepsListSchema = {
  tags: ['steps'],
  summary: 'Adımlar (türetilmiş km, kcal, dk)',
  security: bearer,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      range: { type: 'string', enum: ['day', 'week', 'month'], default: 'week' },
      date: localDateSchema,
    },
  },
  response: { 200: envelope(stepsList) },
};

// ── Uyku ──────────────────────────────────────────────────────────────
const sleepEntry = {
  type: 'object',
  properties: {
    id: uuidSchema,
    sleepStart: { type: 'string' },
    sleepEnd: { type: 'string' },
    durationMinutes: { type: 'integer' },
    localDate: { type: 'string' },
    quality: nint,
    source: { type: 'string' },
  },
};
const sleepResponse = envelope({ type: 'object', properties: { entry: sleepEntry } });
const quality = { type: ['integer', 'null'], minimum: 1, maximum: 5 };

export const sleepCreateSchema = {
  tags: ['sleep'],
  summary: 'Uyku kaydı',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['sleepStart', 'sleepEnd'],
    properties: { id: uuidSchema, sleepStart: dateTime, sleepEnd: dateTime, quality },
  },
  response: { 200: sleepResponse, 201: sleepResponse },
};

export const sleepUpdateSchema = {
  tags: ['sleep'],
  summary: 'Uyku kaydını düzenle',
  security: bearer,
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: { sleepStart: dateTime, sleepEnd: dateTime, quality },
  },
  response: { 200: sleepResponse },
};

export const sleepDeleteSchema = {
  tags: ['sleep'],
  summary: 'Uyku kaydını sil',
  security: bearer,
  params: idParams,
  response: { 200: envelope({ type: 'object' }) },
};

export const sleepSyncSchema = {
  tags: ['sleep'],
  summary: 'Sağlık uygulamasından toplu uyku aktarımı',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'entries'],
    properties: {
      source: healthSource,
      entries: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['externalId', 'sleepStart', 'sleepEnd'],
          properties: {
            externalId: { type: 'string', minLength: 1, maxLength: 128 },
            sleepStart: dateTime,
            sleepEnd: dateTime,
          },
        },
      },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: { created: { type: 'integer' }, updated: { type: 'integer' } },
    }),
  },
};

export const sleepSummarySchema = {
  tags: ['sleep'],
  summary: 'Uyku özeti (son gece, hedef, hafta)',
  security: bearer,
  querystring: dateQuery,
  response: {
    200: envelope({
      type: 'object',
      properties: {
        date: { type: 'string' },
        lastNight: {
          type: ['object', 'null'],
          properties: { ...sleepEntry.properties, totalMinutes: { type: 'integer' } },
        },
        goalMin: { type: 'integer' },
        progress: { type: 'number' },
        schedule: {
          type: 'object',
          properties: { bedtime: nstr, wakeTime: nstr },
        },
        scheduleSet: { type: 'boolean' },
        week: {
          type: 'array',
          items: {
            type: 'object',
            properties: { date: { type: 'string' }, minutes: { type: 'integer' } },
          },
        },
      },
    }),
  },
};
