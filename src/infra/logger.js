import { pino } from 'pino';

/**
 * Loglarda ASLA bulunmaması gereken alanlar (token, sağlık notu, sohbet içeriği, e-posta…).
 * pino redact yolları; `*.x` bir seviye joker.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-install-id"]',
  'headers.authorization',
  '*.authorization',
  '*.password',
  '*.idToken',
  '*.accessToken',
  '*.refreshToken',
  '*.authorizationCode',
  '*.pushToken',
  '*.email',
  '*.notes',
  '*.content',
  '*.text',
];

/**
 * Fastify'ın ve diğer process'lerin kullandığı ortak pino ayarları.
 */
export function buildLoggerOptions(config) {
  return {
    level: config.log.level,
    base: { env: config.env, release: config.release },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    ...(config.log.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,env,release' },
          },
        }
      : {}),
  };
}

/**
 * Worker/scheduler/script'ler için bağımsız logger.
 */
export function createLogger(config, bindings = {}) {
  return pino(buildLoggerOptions(config)).child(bindings);
}
