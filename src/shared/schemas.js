/**
 * Ortak JSON Schema parçaları. Yanıt şemaları ZARFIN TAMAMINI tanımlar; fast-json-stringify
 * yalnızca tanımlı alanları serileştirir (istenmeyen alan sızıntısı yapısal olarak engellenir).
 */

export const uuidSchema = { type: 'string', format: 'uuid' };
export const isoDateTimeSchema = { type: 'string', format: 'date-time' };
export const localDateSchema = { type: 'string', format: 'date' };

/**
 * Başarılı yanıt zarfı: { status: "success", message, data }.
 */
export function envelope(dataSchema) {
  return {
    type: 'object',
    required: ['status', 'message', 'data'],
    properties: {
      status: { type: 'string', enum: ['success'] },
      message: { type: 'string' },
      data: dataSchema,
    },
  };
}

/**
 * Liste yanıtı: data HER ZAMAN nesnedir (istemci `data` dizisini parse edemiyor).
 */
export function pagedEnvelope(itemSchema) {
  return envelope({
    type: 'object',
    required: ['items', 'pageInfo'],
    properties: {
      items: { type: 'array', items: itemSchema },
      pageInfo: {
        type: 'object',
        required: ['nextCursor', 'hasMore'],
        properties: {
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
      },
    },
  });
}

/** Hata zarfı (OpenAPI belgeleri için). */
export const errorEnvelope = {
  type: 'object',
  required: ['status', 'message', 'error'],
  properties: {
    status: { type: 'string', enum: ['error'] },
    message: { type: 'string' },
    error: {
      type: 'object',
      required: ['code', 'requestId'],
      properties: {
        code: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        requestId: { type: 'string' },
      },
    },
  },
};

/** Sayfalama sorgu parametreleri. */
export const pageQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    cursor: { type: 'string', maxLength: 512 },
  },
};
