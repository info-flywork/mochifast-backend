import fp from 'fastify-plugin';
import { HEADERS, PLATFORMS } from '../config/constants.js';
import { resolveLocale } from '../shared/i18n.js';
import { isUuid, newId } from '../shared/ids.js';
import { isValidTimezone } from '../shared/time.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;
const APP_VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}([+-][0-9A-Za-z.-]{1,32})?$/;

/**
 * İstemcinin gönderdiği X-Request-Id güvenliyse (log enjeksiyonuna karşı biçim kontrolü) kullanılır,
 * değilse UUIDv7 üretilir. Fastify `genReqId` olarak kullanılır.
 */
export function generateRequestId(req) {
  const incoming = req.headers[HEADERS.requestId];
  return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : newId();
}

/**
 * Her isteğe `request.ctx` ekler: dil, saat dilimi, uygulama sürümü, platform, kurulum kimliği.
 * Hatalı header'lar isteği reddetmez; `null` olarak geçer (doğrulama gereken uçlar kendisi ister).
 */
export default fp(
  async function requestContext(app) {
    app.decorateRequest('ctx', null);

    app.addHook('onRequest', async (request, reply) => {
      const h = request.headers;
      const timezone = header(h, HEADERS.timezone);
      const appVersion = header(h, HEADERS.appVersion);
      const platform = header(h, HEADERS.platform)?.toLowerCase();
      const installId = header(h, HEADERS.installId);

      request.ctx = {
        requestId: request.id,
        locale: resolveLocale(header(h, 'accept-language')),
        timezone: isValidTimezone(timezone) ? timezone : null,
        appVersion: appVersion && APP_VERSION_PATTERN.test(appVersion) ? appVersion : null,
        platform: platform && PLATFORMS.includes(platform) ? platform : null,
        installId: isUuid(installId) ? installId : null,
      };
      reply.header(HEADERS.requestId, request.id);
    });
  },
  { name: 'request-context' },
);

function header(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}
