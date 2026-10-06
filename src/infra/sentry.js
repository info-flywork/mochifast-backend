import * as Sentry from '@sentry/node';

let enabled = false;

/**
 * SENTRY_DSN tanımlıysa Sentry'yi başlatır. PII gönderilmez.
 * @param serverName api | worker | scheduler
 */
export function initSentry(config, serverName) {
  if (!config.sentry.dsn) return;
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.env,
    release: config.release,
    serverName,
    // Sağlık verisi işliyoruz: kullanıcı bilgisi, header, cookie, gövde, query parametresi GÖNDERİLMEZ.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    tracesSampleRate: config.sentry.tracesSampleRate,
  });
  enabled = true;
}

/**
 * @param [context] PII içermemeli (requestId, route, userId)
 */
export function captureException(err, context) {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (context) scope.setContext('request', context);
    Sentry.captureException(err);
  });
}

/** Kapanışta bekleyen olayları gönder. */
export async function flushSentry(timeoutMs = 2_000) {
  if (enabled) await Sentry.close(timeoutMs);
}
