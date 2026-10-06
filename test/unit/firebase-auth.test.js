import { describe, expect, it } from 'vitest';
import { createFirebaseVerifier } from '../../src/infra/firebase-auth.js';
import { fakeFirebase } from '../helpers/app.js';

describe('Firebase ID token doğrulama', () => {
  it('proje kimliği yoksa giriş kapalı: 400 provider_disabled', async () => {
    const verifier = createFirebaseVerifier({ projectId: '', allowedProviders: ['apple.com'] });
    expect(verifier.enabled).toBe(false);
    await expect(verifier.verify('x')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      details: { reason: 'provider_disabled' },
    });
  });

  it('geçerli token → uid, yöntem, e-posta; gelecekteki auth_time reddedilir', async () => {
    const fb = await fakeFirebase();
    const verifier = createFirebaseVerifier({
      projectId: 'mochifast-test',
      allowedProviders: ['apple.com', 'google.com'],
      jwks: fb.jwks,
    });
    const token = await fb.sign({ uid: 'u1', email: 'a@b.c', email_verified: true, name: ' Ece ' });
    expect(await verifier.verify(token)).toEqual({
      subject: 'u1',
      signInProvider: 'apple.com',
      email: 'a@b.c',
      emailVerified: true,
      name: 'Ece',
    });
    const future = await fb.sign({ uid: 'u1', auth_time: Math.floor(Date.now() / 1000) + 3600 });
    await expect(verifier.verify(future)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
