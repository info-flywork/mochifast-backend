import fp from 'fastify-plugin';
import { AppError, isAppError } from '../shared/errors.js';
import { t } from '../shared/i18n.js';
import { captureException } from '../infra/sentry.js';

/**
 * Tüm hataları tek biçime çevirir:
 * { status: "error", message: <yerelleştirilmiş>, error: { code, details?, requestId } }
 * 5xx detayları ASLA istemciye sızdırılmaz.
 */
export default fp(
  async function errors(app) {
    app.setErrorHandler(async (err, request, reply) => {
      const appError = toAppError(err);
      const status = appError.statusCode;

      if (appError.code === 'UNAVAILABLE') {
        // Beklenen durum (bakım, aşırı yük, readiness): nedeni zaten kaynağında loglanır.
        request.log.debug(
          { code: appError.code, details: appError.details },
          'servis kullanılamıyor',
        );
      } else if (status >= 500) {
        request.log.error({ err }, 'istek hatası');
        captureException(err, { requestId: request.id, route: request.routeOptions.url });
      } else {
        request.log.debug({ code: appError.code, err: appError.message }, 'istemci hatası');
      }

      if (appError.headers) reply.headers(appError.headers);
      return reply.status(status).send(errorBody(request, appError));
    });

    app.setNotFoundHandler(async (request, reply) => {
      return reply.status(404).send(errorBody(request, new AppError('NOT_FOUND')));
    });
  },
  { name: 'errors', dependencies: ['request-context'] },
);

function errorBody(request, appError) {
  const locale = request.ctx?.locale ?? 'en';
  return {
    status: 'error',
    message: t(locale, `errors.${appError.code}`, appError.params),
    error: {
      code: appError.code,
      ...(appError.details ? { details: appError.details } : {}),
      requestId: request.id,
    },
  };
}

/**
 * Fastify/eklenti/bilinmeyen hataları katalog koduna eşler.
 */
export function toAppError(err) {
  if (isAppError(err)) return err;

  if (Array.isArray(err?.validation)) {
    return new AppError('VALIDATION_FAILED', {
      details: {
        fields: err.validation.map((v) => fieldError(v, err.validationContext)),
      },
      cause: err,
    });
  }

  switch (err?.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new AppError('PAYLOAD_TOO_LARGE', { cause: err });
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new AppError('UNSUPPORTED_MEDIA_TYPE', { cause: err });
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return new AppError('INVALID_JSON', { cause: err });
    default:
      break;
  }
  if (err instanceof SyntaxError && err.statusCode === 400) {
    return new AppError('INVALID_JSON', { cause: err });
  }

  const status = Number(err?.statusCode);
  if (status >= 400 && status < 500) {
    const byStatus = {
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      405: 'METHOD_NOT_ALLOWED',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      415: 'UNSUPPORTED_MEDIA_TYPE',
      429: 'RATE_LIMITED',
    };
    return new AppError(byStatus[status] ?? 'BAD_REQUEST', { cause: err });
  }
  if (status === 503) return new AppError('UNAVAILABLE', { cause: err });
  return new AppError('INTERNAL', { cause: err, message: err?.message });
}

/**
 * Ajv hatası → { path, message, keyword }. Yol: "body.weightKg", "querystring.limit".
 */
function fieldError(v, context) {
  const base = String(v.instancePath ?? '')
    .replace(/^\//, '')
    .replaceAll('/', '.');
  const prop = v.params?.missingProperty ?? v.params?.additionalProperty;
  const path = [context, base, prop].filter(Boolean).join('.');
  return {
    path: path || String(context ?? ''),
    message: String(v.message ?? 'invalid'),
    keyword: v.keyword,
  };
}
