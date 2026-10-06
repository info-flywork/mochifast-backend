import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, createLocalJWKSet, errors as joseErrors, importJWK, jwtVerify } from 'jose';
import { AppError } from '../shared/errors.js';

/**
 * Access token (JWT, EdDSA/Ed25519, `kid`'li) ve opak refresh token (docs/backend/06-guvenlik.md §2.2).
 *
 * Access token yalnızca `sub` (userId) ve `sid` (sessionId) taşır; rol/premium bilgisi bilinçli
 * olarak yoktur, her istekte sunucuda kontrol edilir.
 *
 * Anahtar rotasyonu: yeni anahtar üretilir (`npm run keys:jwt`), JWT_PRIVATE_JWK yeni anahtar olur,
 * JWT_PUBLIC_JWKS'e eklenir; eski açık anahtar access ömrü (15 dk) kadar listede kalır.
 */

export const ACCESS_ALG = 'EdDSA';

/**
 * @param options.privateJwk imzalama anahtarı (OKP/Ed25519, `kid` zorunlu)
 * @param options.publicJwks doğrulamada kabul edilen açık anahtarlar
 */
export async function createTokenService({
  privateJwk,
  publicJwks,
  issuer,
  audience,
  accessTtlSec,
}) {
  if (!privateJwk.kid) throw new Error('JWT_PRIVATE_JWK bir `kid` içermeli');
  if (!publicJwks.some((k) => k.kid === privateJwk.kid)) {
    throw new Error('JWT_PUBLIC_JWKS, imzalama anahtarının (kid) açık anahtarını içermeli');
  }
  const signingKey = await importJWK(privateJwk, ACCESS_ALG);
  const keySet = createLocalJWKSet({ keys: publicJwks });

  return {
    accessTtlSec,

    async signAccess({ userId, sessionId }) {
      const token = await new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: ACCESS_ALG, kid: privateJwk.kid, typ: 'JWT' })
        .setSubject(userId)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(`${accessTtlSec}s`)
        .sign(signingKey);
      return { token, expiresIn: accessTtlSec };
    },

    /** Geçerliyse `{ userId, sessionId }`; değilse AppError (TOKEN_EXPIRED | UNAUTHENTICATED). */
    async verifyAccess(token) {
      try {
        const { payload } = await jwtVerify(token, keySet, {
          algorithms: [ACCESS_ALG],
          issuer,
          audience,
          clockTolerance: 5,
          requiredClaims: ['sub', 'sid', 'exp', 'iat'],
        });
        if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
          throw new AppError('UNAUTHENTICATED', { message: 'eksik claim' });
        }
        return { userId: payload.sub, sessionId: payload.sid };
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (err instanceof joseErrors.JWTExpired) {
          throw new AppError('TOKEN_EXPIRED', { cause: err });
        }
        throw new AppError('UNAUTHENTICATED', {
          message: `geçersiz access token: ${err.code}`,
          cause: err,
        });
      }
    },
  };
}

/** 256 bit rastgele, `rt_` önekli opak refresh token. */
export function newRefreshToken() {
  return `rt_${randomBytes(32).toString('base64url')}`;
}

/** Refresh token'ın DB'de saklanan SHA-256 hash'i (hex). */
export function hashRefreshToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
