import { envelope } from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const nstr = { type: ['string', 'null'] };

const subscription = {
  type: 'object',
  properties: {
    isPremium: { type: 'boolean' },
    entitlement: { type: 'string' },
    status: nstr,
    productId: nstr,
    store: nstr,
    environment: nstr,
    periodType: nstr,
    willRenew: { type: 'boolean' },
    expiresAt: nstr,
    graceExpiresAt: nstr,
    managementUrl: nstr,
  },
};
const response = { 200: envelope({ type: 'object', properties: { subscription } }) };

export const getSchema = {
  tags: ['subscription'],
  summary: 'Abonelik durumu (sunucunun yetki kararı)',
  security: bearer,
  response,
};

export const syncSchema = {
  tags: ['subscription'],
  summary: 'Satın alma / geri yükleme sonrası RevenueCat ile anında senkron',
  security: bearer,
  response,
};

export const webhookSchema = {
  tags: ['subscription'],
  summary: 'RevenueCat webhook (Authorization başlığı ile)',
  body: { type: 'object', additionalProperties: true, required: ['event'] },
  response: {
    200: envelope({
      type: 'object',
      properties: { received: { type: 'boolean' }, duplicate: { type: 'boolean' } },
    }),
  },
};
