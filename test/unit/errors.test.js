import { describe, expect, it } from 'vitest';
import { toAppError } from '../../src/plugins/errors.js';
import { AppError, ERROR_CODES } from '../../src/shared/errors.js';

describe('toAppError', () => {
  it('AppError olduğu gibi geçer', () => {
    const e = new AppError('ACTIVE_FAST_EXISTS', { details: { activeFastId: 'x' } });
    expect(toAppError(e)).toBe(e);
    expect(e.statusCode).toBe(409);
  });

  it('Fastify şema hatası → VALIDATION_FAILED + alan yolları', () => {
    const err = Object.assign(new Error('bad'), {
      validationContext: 'body',
      validation: [
        { instancePath: '/weightKg', message: 'must be <= 350', keyword: 'maximum', params: {} },
        {
          instancePath: '',
          message: "must have required property 'age'",
          keyword: 'required',
          params: { missingProperty: 'age' },
        },
      ],
    });
    const mapped = toAppError(err);
    expect(mapped.code).toBe('VALIDATION_FAILED');
    expect(mapped.details?.fields).toEqual([
      { path: 'body.weightKg', message: 'must be <= 350', keyword: 'maximum' },
      { path: 'body.age', message: "must have required property 'age'", keyword: 'required' },
    ]);
  });

  it.each([
    ['FST_ERR_CTP_BODY_TOO_LARGE', 'PAYLOAD_TOO_LARGE'],
    ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 'UNSUPPORTED_MEDIA_TYPE'],
    ['FST_ERR_CTP_INVALID_JSON_BODY', 'INVALID_JSON'],
    ['FST_ERR_CTP_EMPTY_JSON_BODY', 'INVALID_JSON'],
  ])('%s → %s', (code, expected) => {
    expect(toAppError(Object.assign(new Error(), { code })).code).toBe(expected);
  });

  it('bilinmeyen hata → INTERNAL (500)', () => {
    const mapped = toAppError(new TypeError('x is undefined'));
    expect(mapped.code).toBe('INTERNAL');
    expect(mapped.statusCode).toBe(500);
  });

  it('statusCode taşıyan 4xx hatalar katalog koduna eşlenir', () => {
    expect(toAppError(Object.assign(new Error(), { statusCode: 401 })).code).toBe(
      'UNAUTHENTICATED',
    );
    expect(toAppError(Object.assign(new Error(), { statusCode: 418 })).code).toBe('BAD_REQUEST');
  });

  it('katalogdaki her kodun HTTP durumu geçerli aralıkta', () => {
    for (const status of Object.values(ERROR_CODES)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});
