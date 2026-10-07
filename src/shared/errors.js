/**
 * Hata kodu kataloğu (docs/backend/02-mimari.md §4.2).
 * İstemci yalnızca `code`'a bakar; `message` yerelleştirilmiş, kullanıcıya gösterilebilir metindir.
 * Yeni kod eklerken `src/locales/*.json` içindeki `errors.<CODE>` çevirilerini de ekleyin.
 */
export const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: 400,
  INVALID_JSON: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  REFRESH_REUSED: 401,
  PREMIUM_REQUIRED: 402,
  FORBIDDEN: 403,
  CONSENT_REQUIRED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  ACTIVE_FAST_EXISTS: 409,
  FAST_OVERLAP: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  ACCOUNT_LINK_CONFLICT: 409,
  ACCOUNT_PENDING_DELETION: 409,
  REPLY_IN_PROGRESS: 409,
  GONE: 410,
  ACCOUNT_LOCKED: 423,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  NOT_FOOD: 422,
  UNSAFE_REQUEST: 422,
  SAFETY_ACK_REQUIRED: 422,
  APP_UPDATE_REQUIRED: 426,
  QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
});

/**
 * Uygulama hatası. Service katmanı yalnızca bunu (veya alt sınıflarını) fırlatır;
 * errors eklentisi zarfa çevirir.
 */
export class AppError extends Error {
  /**
   * @param [options.details] istemciye dönen yapılandırılmış ayrıntı (PII yok)
   * @param [options.params] çeviri yer tutucuları
   * @param [options.message] log/geliştirici mesajı (kullanıcıya gösterilmez)
   * @param [options.headers] yanıta eklenecek header'lar (ör. Retry-After)
   */
  constructor(code, options = {}) {
    super(options.message ?? code, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_CODES[code];
    this.details = options.details;
    this.params = options.params;
    this.headers = options.headers;
  }
}

export function isAppError(err) {
  return err instanceof AppError;
}

/** Sık kullanılan kısayollar. */
export const errors = {
  notFound: (details) => new AppError('NOT_FOUND', { details }),
  forbidden: (details) => new AppError('FORBIDDEN', { details }),
  conflict: (details) => new AppError('CONFLICT', { details }),
  validation: (fields) => new AppError('VALIDATION_FAILED', { details: { fields } }),
  unauthenticated: () => new AppError('UNAUTHENTICATED'),
};
