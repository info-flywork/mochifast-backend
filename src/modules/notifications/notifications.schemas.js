import { envelope, pagedEnvelope, pageQuerySchema, uuidSchema } from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const nstr = { type: ['string', 'null'] };
const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: uuidSchema },
};

const item = {
  type: 'object',
  properties: {
    id: uuidSchema,
    type: { type: 'string' },
    category: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
    iconKey: nstr,
    deepLink: nstr,
    createdAt: { type: 'string' },
    readAt: nstr,
  },
};

export const listSchema = {
  tags: ['notifications'],
  summary: 'Gelen kutusu (kullanıcının diliyle render edilmiş)',
  security: bearer,
  querystring: pageQuerySchema,
  response: { 200: pagedEnvelope(item) },
};
export const unreadSchema = {
  tags: ['notifications'],
  summary: 'Okunmamış sayısı',
  security: bearer,
  response: { 200: envelope({ type: 'object', properties: { count: { type: 'integer' } } }) },
};
export const readSchema = {
  tags: ['notifications'],
  summary: 'Okundu işaretle',
  security: bearer,
  params: idParams,
  response: { 200: envelope({ type: 'object' }) },
};
export const readAllSchema = {
  tags: ['notifications'],
  summary: 'Tümünü okundu işaretle',
  security: bearer,
  response: { 200: envelope({ type: 'object', properties: { updated: { type: 'integer' } } }) },
};
export const deleteSchema = {
  tags: ['notifications'],
  summary: 'Bildirimi sil',
  security: bearer,
  params: idParams,
  response: { 200: envelope({ type: 'object' }) },
};
