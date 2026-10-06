import { createHash } from 'node:crypto';
import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from 'jose';
import { AppError } from '../shared/errors.js';

/**
 * Apple ve Google kimlik token'larının doğrulanması (docs/backend/06-guvenlik.md §2.1).
 * Kimlik her zaman `sub`'dır; e-posta yalnızca bilgi amaçlıdır.
 */

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const CLOCK_TOLERANCE_SEC = 60;
const HTTP_TIMEOUT_MS = 5_000;

/**
 * @param options.config `config.identity` (apple: audiences/teamId/keyId/privateKeyP8, google: clientIds)
 * @param [options.appleJwks] test için (createLocalJWKSet)
 * @param [options.googleJwks] test için
 * @param [options.fetch] test için
 */
export function createIdentityProviders({
  config,
  appleJwks,
  googleJwks,
  fetch = globalThis.fetch,
  logger,
}) {
  // JWKS'ler ilk kullanımda oluşturulur; jose anahtarları önbellekler ve yeni `kid` görünce yeniler.
  let apple = appleJwks;
  let google = googleJwks;
  let appleClientSecret = null;

  async function verify(idToken, keySet, options, provider) {
    try {
      const { payload } = await jwtVerify(idToken, keySet, {
        ...options,
        clockTolerance: CLOCK_TOLERANCE_SEC,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      return payload;
    } catch (err) {
      throw new AppError('UNAUTHENTICATED', {
        message: `${provider} kimlik token'ı geçersiz: ${err.code ?? err.message}`,
        cause: err,
      });
    }
  }

  /** Apple /auth/token için ES256 client secret (5 dk geçerli, önbellekli). */
  async function getAppleClientSecret() {
    const now = Math.floor(Date.now() / 1000);
    if (appleClientSecret && appleClientSecret.exp - 60 > now) return appleClientSecret.value;
    const { teamId, keyId, privateKeyP8, audiences } = config.apple;
    const key = await importPKCS8(privateKeyP8, 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: keyId })
      .setIssuer(teamId)
      .setSubject(audiences[0])
      .setAudience(APPLE_ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key);
    appleClientSecret = { value, exp: now + 300 };
    return value;
  }

  return {
    /**
     * @param rawNonce istemcinin ürettiği ham nonce; token'daki `nonce` = SHA-256(rawNonce) (hex)
     */
    async verifyApple({ idToken, rawNonce }) {
      apple ??= createRemoteJWKSet(new URL(APPLE_JWKS_URL));
      const payload = await verify(
        idToken,
        apple,
        { issuer: APPLE_ISSUER, audience: config.apple.audiences },
        'apple',
      );
      const expected = createHash('sha256').update(rawNonce, 'utf8').digest('hex');
      if (payload.nonce !== expected) {
        throw new AppError('UNAUTHENTICATED', { message: 'apple nonce eşleşmedi' });
      }
      return {
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        name: null,
      };
    },

    async verifyGoogle({ idToken }) {
      if (config.google.clientIds.length === 0) {
        throw new AppError('BAD_REQUEST', {
          details: { reason: 'provider_disabled' },
          message: 'GOOGLE_CLIENT_IDS tanımlı değil',
        });
      }
      google ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
      const payload = await verify(
        idToken,
        google,
        { issuer: GOOGLE_ISSUERS, audience: config.google.clientIds },
        'google',
      );
      return {
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true,
        name: typeof payload.name === 'string' ? payload.name.slice(0, 60) : null,
      };
    },

    /** Apple sunucu tarafı yapılandırılmış mı (hesap silmede revoke için refresh token alınabilir mi)? */
    get appleCodeExchangeEnabled() {
      const { teamId, keyId, privateKeyP8 } = config.apple;
      return Boolean(teamId && keyId && privateKeyP8);
    },

    /**
     * `authorizationCode` → Apple refresh token. Başarısızlık girişi ENGELLEMEZ (null döner, loglanır):
     * token yalnızca hesap silmede Apple tarafında iptal için gerekir.
     */
    async exchangeAppleCode(code) {
      if (!this.appleCodeExchangeEnabled) {
        logger?.warn('Apple anahtarı tanımlı değil; authorizationCode takası atlandı');
        return null;
      }
      try {
        const res = await fetch(APPLE_TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.apple.audiences[0],
            client_secret: await getAppleClientSecret(),
            code,
            grant_type: 'authorization_code',
          }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || typeof body.refresh_token !== 'string') {
          logger?.warn({ status: res.status, error: body.error }, 'Apple code takası başarısız');
          return null;
        }
        return body.refresh_token;
      } catch (err) {
        logger?.warn({ err }, 'Apple code takası başarısız');
        return null;
      }
    },
  };
}
