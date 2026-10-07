import { envelope, pagedEnvelope, pageQuerySchema, uuidSchema } from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const nstr = { type: ['string', 'null'] };
const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: uuidSchema },
};

const conversation = {
  type: 'object',
  properties: {
    id: uuidSchema,
    title: nstr,
    isPinned: { type: 'boolean' },
    messageCount: { type: 'integer' },
    contextSource: { type: 'string' },
    lastMessageAt: nstr,
    createdAt: { type: 'string' },
  },
};

const message = {
  type: 'object',
  properties: {
    id: uuidSchema,
    role: { type: 'string', enum: ['user', 'assistant'] },
    text: { type: 'string' },
    status: { type: 'string' },
    safety: { type: 'string', enum: ['none', 'urgent'] },
    feedback: nstr,
    createdAt: { type: 'string' },
  },
};

export const suggestionsSchema = {
  tags: ['chat'],
  summary: 'Sohbet önerileri',
  security: bearer,
  querystring: {
    type: 'object',
    additionalProperties: false,
    // Bağlama göre süzme katalogda henüz yok; parametre kabul edilir, tüm öneriler döner.
    properties: { context: { type: 'string', maxLength: 40 } },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { code: { type: 'string' }, text: { type: 'string' } },
          },
        },
      },
    }),
  },
};

export const listSchema = {
  tags: ['chat'],
  summary: 'Konuşmalar (önce sabitlenenler, sonra son mesaja göre)',
  security: bearer,
  querystring: pageQuerySchema,
  response: { 200: pagedEnvelope(conversation) },
};

export const createSchema = {
  tags: ['chat'],
  summary: 'Konuşma başlat',
  security: bearer,
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: {
      contextSource: {
        type: 'string',
        enum: ['direct', 'hungerResult', 'fastingStruggle', 'suggestion'],
      },
      contextRef: uuidSchema,
    },
  },
  response: { 201: envelope({ type: 'object', properties: { conversation } }) },
};

export const updateSchema = {
  tags: ['chat'],
  summary: 'Sabitle / yeniden adlandır',
  security: bearer,
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      isPinned: { type: 'boolean' },
      title: { type: 'string', minLength: 1, maxLength: 120 },
    },
  },
  response: { 200: envelope({ type: 'object', properties: { conversation } }) },
};

export const deleteSchema = {
  tags: ['chat'],
  summary: 'Konuşmayı sil',
  security: bearer,
  params: idParams,
  response: { 200: envelope({ type: 'object' }) },
};

export const messagesSchema = {
  tags: ['chat'],
  summary: 'Mesajlar (eskiden yeniye; imleç daha eskileri getirir)',
  security: bearer,
  params: idParams,
  querystring: {
    ...pageQuerySchema,
    properties: {
      ...pageQuerySchema.properties,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
  },
  response: { 200: pagedEnvelope(message) },
};

export const sendSchema = {
  tags: ['chat'],
  summary: 'Mesaj gönder (Accept: text/event-stream → SSE; application/json → tam yanıt)',
  security: bearer,
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      id: uuidSchema,
      text: { type: 'string', minLength: 1, maxLength: 2000 },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        userMessageId: uuidSchema,
        assistantMessage: message,
        remainingToday: { type: ['integer', 'null'] },
      },
    }),
  },
};

export const feedbackSchema = {
  tags: ['chat'],
  summary: 'Yanıt değerlendirmesi',
  security: bearer,
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['rating'],
    properties: {
      rating: { type: 'string', enum: ['up', 'down'] },
      reason: { type: 'string', maxLength: 200 },
    },
  },
  response: { 200: envelope({ type: 'object' }) },
};
