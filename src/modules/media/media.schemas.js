import { envelope, uuidSchema } from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const nstr = { type: ['string', 'null'] };

/** Yanıtlara gömülen medya (imzalı URL'ler). İstemci cache anahtarı: `${id}_${variant}`. */
export const mediaSchema = {
  type: ['object', 'null'],
  properties: {
    id: uuidSchema,
    url: nstr,
    thumbUrl: nstr,
    variants: { type: 'object', additionalProperties: { type: 'string' } },
    width: { type: ['integer', 'null'] },
    height: { type: ['integer', 'null'] },
    blurhash: nstr,
    expiresAt: nstr,
  },
};

const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: uuidSchema },
};

export const uploadSchema = {
  tags: ['media'],
  summary: 'Fotoğraf yükle (multipart: file; purpose=mealPhoto)',
  security: bearer,
  consumes: ['multipart/form-data'],
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { purpose: { type: 'string', enum: ['mealPhoto'] } },
  },
  response: {
    200: envelope({ type: 'object', properties: { media: mediaSchema } }),
    201: envelope({ type: 'object', properties: { media: mediaSchema } }),
  },
};

export const getSchema = {
  tags: ['media'],
  summary: 'Medya (yenilenmiş imzalı URL)',
  security: bearer,
  params: idParams,
  response: { 200: envelope({ type: 'object', properties: { media: mediaSchema } }) },
};

export const deleteSchema = {
  tags: ['media'],
  summary: 'Medyayı sil',
  security: bearer,
  params: idParams,
  response: { 200: envelope({ type: 'object' }) },
};

export const avatarPutSchema = {
  tags: ['user'],
  summary: 'Avatar yükle (multipart: file)',
  security: bearer,
  consumes: ['multipart/form-data'],
  response: { 200: envelope({ type: 'object', properties: { avatar: mediaSchema } }) },
};

export const avatarDeleteSchema = {
  tags: ['user'],
  summary: 'Avatarı kaldır',
  security: bearer,
  response: { 200: envelope({ type: 'object' }) },
};
