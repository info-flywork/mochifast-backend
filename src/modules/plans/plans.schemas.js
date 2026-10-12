import { envelope, localDateSchema, pagedEnvelope, pageQuerySchema } from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const hhmm = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' };
const nstr = { type: ['string', 'null'] };

const scheduleDay = {
  type: 'object',
  additionalProperties: false,
  required: ['dow', 'type'],
  properties: {
    dow: { type: 'integer', minimum: 1, maximum: 7 },
    type: { type: 'string', enum: ['fast', 'normal', 'reduced'] },
    fastMinutes: { type: 'integer', minimum: 60, maximum: 1440 },
    kcal: { type: 'integer', minimum: 0, maximum: 2000 },
  },
};

/** Kullanıcı planı DTO'su (`/plans/current` ve `/user/summary.plan`). */
export const userPlanSchema = {
  type: ['object', 'null'],
  properties: {
    id: { type: 'string' },
    planCode: { type: 'string' },
    displayName: { type: 'string' },
    category: nstr,
    scheduleType: nstr,
    timing: nstr,
    fastMinutes: { type: 'integer' },
    eatWindow: { type: ['object', 'null'], properties: { start: hhmm, end: hhmm } },
    weeklySchedule: {
      type: ['array', 'null'],
      items: { type: 'object', properties: scheduleDay.properties },
    },
    startedOn: { type: 'string' },
    endedAt: nstr,
    isPremium: { type: 'boolean' },
    requiresSafetyAck: { type: 'boolean' },
    safetyAcknowledgedAt: nstr,
  },
};

const currentResponse = envelope({
  type: 'object',
  required: ['plan', 'pendingPlanCode'],
  properties: { plan: userPlanSchema, pendingPlanCode: nstr },
});

export const getCurrentSchema = {
  tags: ['plans'],
  summary: 'Aktif plan',
  security: bearer,
  response: { 200: currentResponse },
};

export const putCurrentSchema = {
  tags: ['plans'],
  summary: 'Plan seç / değiştir (bir sonraki oruçtan itibaren geçerli)',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['planCode'],
    properties: {
      planCode: { type: 'string', pattern: '^[a-z0-9_]{2,32}$' },
      timing: {
        type: 'string',
        enum: ['skipBreakfast', 'skipDinner', 'earlyWindow', 'lateWindow', 'custom'],
      },
      eatWindow: {
        type: 'object',
        additionalProperties: false,
        required: ['start'],
        properties: { start: hhmm, end: hhmm },
      },
      fastMinutes: { type: 'integer', minimum: 60, maximum: 1440 },
      weeklySchedule: { type: 'array', minItems: 7, maxItems: 7, items: scheduleDay },
      safetyAcknowledged: { type: 'boolean' },
    },
  },
  response: { 200: currentResponse },
};

export const checkinSchema = {
  tags: ['plans'],
  summary: 'Haftalık planda azaltılmış/oruç gününü işaretle',
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
    required: ['status'],
    properties: { status: { type: 'string', enum: ['done', 'skipped'] } },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        date: { type: 'string' },
        dayType: { type: 'string' },
        status: { type: 'string' },
      },
    }),
  },
};

export const historySchema = {
  tags: ['plans'],
  summary: 'Plan geçmişi',
  security: bearer,
  querystring: pageQuerySchema,
  response: { 200: pagedEnvelope(userPlanSchema) },
};
