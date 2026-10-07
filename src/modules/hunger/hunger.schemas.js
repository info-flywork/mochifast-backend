import {
  envelope,
  localDateSchema,
  pagedEnvelope,
  pageQuerySchema,
  uuidSchema,
} from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const nstr = { type: ['string', 'null'] };
const enumOf = (values) => ({ type: 'string', enum: values });
const setOf = (values) => ({
  type: 'array',
  uniqueItems: true,
  maxItems: values.length,
  items: enumOf(values),
});

const answers = {
  symptoms: setOf(['sleeplessness', 'headache', 'dizziness', 'nausea', 'fatigue', 'weakness']),
  q1: enumOf(['yes', 'notReally', 'notSure']),
  q2: enumOf(['gradually', 'suddenly', 'notSure']),
  bodyNotices: setOf([
    'stomachGrowling',
    'lowEnergy',
    'dizziness',
    'nausea',
    'fatigue',
    'nothingPhysical',
  ]),
  q4: enumOf(['almostAnything', 'somethingSweet', 'fastFood', 'notSure']),
};

const evaluation = {
  resultType: { type: 'string' },
  physicalScore: { type: 'integer' },
  emotionalScore: { type: 'integer' },
  safetyFlag: { type: 'boolean' },
  scoringVersion: { type: 'integer' },
  activeFastId: nstr,
  recommendations: {
    type: 'array',
    items: {
      type: 'object',
      properties: { code: { type: 'string' }, title: { type: 'string' } },
    },
  },
};

const checkinSchema = {
  type: 'object',
  properties: {
    id: uuidSchema,
    loggedAt: { type: 'string' },
    localDate: { type: 'string' },
    mode: { type: 'string' },
    symptoms: { type: 'array', items: { type: 'string' } },
    q1: nstr,
    q2: nstr,
    bodyNotices: { type: 'array', items: { type: 'string' } },
    q4: nstr,
    physicalScore: { type: 'integer' },
    emotionalScore: { type: 'integer' },
    resultType: { type: 'string' },
    safetyFlag: { type: 'boolean' },
    scoringVersion: { type: 'integer' },
    notes: nstr,
    fastId: nstr,
    fastedMinutes: { type: ['integer', 'null'] },
  },
};

export const evaluateSchema = {
  tags: ['hunger'],
  summary: 'Durumsuz açlık skorlaması (sonuç ekranı)',
  security: bearer,
  body: { type: 'object', additionalProperties: false, properties: answers },
  response: { 200: envelope({ type: 'object', properties: evaluation }) },
};

const createResponse = envelope({
  type: 'object',
  properties: { checkin: checkinSchema, ...evaluation },
});

export const createSchema = {
  tags: ['hunger'],
  summary: 'Açlık check-in kaydı (sonuç sunucuda yeniden hesaplanır)',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['mode'],
    properties: {
      id: uuidSchema,
      mode: enumOf(['quick', 'full', 'hungryNow']),
      loggedAt: { type: 'string', format: 'date-time' },
      notes: { type: ['string', 'null'], maxLength: 1000 },
      // İstemcinin hesapladığı sonuç kabul edilir ama kullanılmaz (05 §5: güvenilmez).
      resultType: { type: 'string' },
      physicalScore: { type: 'integer' },
      emotionalScore: { type: 'integer' },
      safetyFlag: { type: 'boolean' },
      ...answers,
    },
  },
  response: { 200: createResponse, 201: createResponse },
};

export const listSchema = {
  tags: ['hunger'],
  summary: 'Açlık check-in geçmişi',
  security: bearer,
  querystring: {
    ...pageQuerySchema,
    properties: {
      ...pageQuerySchema.properties,
      date: localDateSchema,
      type: { ...enumOf(['all', 'physical', 'emotional']), default: 'all' },
    },
  },
  response: { 200: pagedEnvelope(checkinSchema) },
};

export const summarySchema = {
  tags: ['hunger'],
  summary: 'Bugün ve son 7 gün',
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
        today: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            total: { type: 'integer' },
            physical: { type: 'integer' },
            emotional: { type: 'integer' },
          },
        },
        week: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string' },
              physical: { type: 'integer' },
              emotional: { type: 'integer' },
              fastedMinutes: { type: 'integer' },
            },
          },
        },
      },
    }),
  },
};

export const deleteSchema = {
  tags: ['hunger'],
  summary: 'Check-in sil',
  security: bearer,
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: uuidSchema },
  },
  response: { 200: envelope({ type: 'object' }) },
};
