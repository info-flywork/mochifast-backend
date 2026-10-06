import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError } from '../shared/errors.js';

/**
 * Firebase Authentication ID token doğrulaması (docs/backend/06-guvenlik.md §2.1).
 *
 * Apple/Google girişini istemcideki Firebase SDK yapar; backend yalnızca Firebase'in imzaladığı
 * ID token'ı yerelde doğrular (Google'ın açık anahtarları önbelleklenir, istek başına ağ çağrısı
 * yok). Kimlik Firebase `uid`'dir (`sub`); e-posta yalnızca bilgi amaçlıdır.
 * Misafir girişi Firebase'de değil, backend'de (cihaz başına tek misafir: POST /v1/auth/guest).
 */

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_TOLERANCE_SEC = 60;

/**
 * @param options.projectId Firebase proje kimliği; boşsa Firebase girişi kapalıdır
 * @param options.allowedProviders kabul edilen `firebase.sign_in_provider` değerleri
 * @param [options.jwks] test için (createLocalJWKSet)
 */
export function createFirebaseVerifier({ projectId, allowedProviders, jwks }) {
  let keySet = jwks;

  return {
    get enabled() {
      return Boolean(projectId);
    },

    /** @returns `{ subject, signInProvider, email, emailVerified, name }` */
    async verify(idToken) {
      if (!projectId) {
        throw new AppError('BAD_REQUEST', {
          details: { reason: 'provider_disabled' },
          message: 'FIREBASE_PROJECT_ID tanımlı değil',
        });
      }
      keySet ??= createRemoteJWKSet(new URL(JWKS_URL));

      let payload;
      try {
        ({ payload } = await jwtVerify(idToken, keySet, {
          algorithms: ['RS256'],
          issuer: `https://securetoken.google.com/${projectId}`,
          audience: projectId,
          clockTolerance: CLOCK_TOLERANCE_SEC,
          requiredClaims: ['sub', 'exp', 'iat', 'auth_time'],
        }));
      } catch (err) {
        throw new AppError('UNAUTHENTICATED', {
          message: `Firebase ID token geçersiz: ${err.code ?? err.message}`,
          cause: err,
        });
      }

      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) {
        throw new AppError('UNAUTHENTICATED', { message: 'Firebase uid geçersiz' });
      }
      if (typeof payload.auth_time !== 'number' || payload.auth_time > now + CLOCK_TOLERANCE_SEC) {
        throw new AppError('UNAUTHENTICATED', { message: 'Firebase auth_time geçersiz' });
      }
      const signInProvider = payload.firebase?.sign_in_provider;
      if (!allowedProviders.includes(signInProvider)) {
        throw new AppError('BAD_REQUEST', {
          details: { reason: 'provider_not_allowed' },
          message: `izin verilmeyen giriş yöntemi: ${signInProvider}`,
        });
      }

      return {
        subject: payload.sub,
        signInProvider,
        email: typeof payload.email === 'string' ? payload.email : null,
        emailVerified: payload.email_verified === true,
        name:
          typeof payload.name === 'string' && payload.name.trim()
            ? payload.name.trim().slice(0, 60)
            : null,
      };
    },
  };
}
