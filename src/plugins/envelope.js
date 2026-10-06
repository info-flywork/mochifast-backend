import fp from 'fastify-plugin';
import { t } from '../shared/i18n.js';

/**
 * Başarılı yanıtları mevcut istemci sözleşmesine sarar: { status: "success", message, data }.
 * Handler'lar yalnızca `data`'yı döner. Hata yanıtları errors eklentisinde üretilir.
 * Ham yanıt gereken route'lar: `config: { rawResponse: true }`.
 */
export default fp(
  async function envelope(app) {
    app.decorateReply('successMessageKey', null);

    app.addHook('preSerialization', async (request, reply, payload) => {
      if (reply.statusCode >= 400 || request.routeOptions.config?.rawResponse) return payload;
      if (isEnvelope(payload)) return payload;
      return {
        status: 'success',
        message: t(request.ctx?.locale ?? 'en', reply.successMessageKey ?? 'common.ok'),
        data: payload ?? {},
      };
    });
  },
  { name: 'envelope', dependencies: ['request-context'] },
);

function isEnvelope(payload) {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'status' in payload &&
    (payload.status === 'success' || payload.status === 'error') &&
    ('data' in payload || 'error' in payload)
  );
}
