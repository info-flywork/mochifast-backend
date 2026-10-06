import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTokenService, hashRefreshToken, newRefreshToken } from '../../src/infra/tokens.js';

async function keyPair(kid) {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  return {
    privateJwk: { ...(await exportJWK(privateKey)), kid },
    publicJwk: { ...(await exportJWK(publicKey)), kid },
  };
}

const opts = { issuer: 'api.test', audience: 'app.test', accessTtlSec: 900 };
const userId = '0192f1e2-0000-7000-8000-000000000001';
const sessionId = '0192f1e2-0000-7000-8000-000000000002';

describe('access token', () => {
  let k1;
  let k2;
  beforeAll(async () => {
    k1 = await keyPair('k1');
    k2 = await keyPair('k2');
  });

  it('imzalar ve doğrular', async () => {
    const svc = await createTokenService({
      ...opts,
      privateJwk: k1.privateJwk,
      publicJwks: [k1.publicJwk],
    });
    const { token, expiresIn } = await svc.signAccess({ userId, sessionId });
    expect(expiresIn).toBe(900);
    expect(await svc.verifyAccess(token)).toEqual({ userId, sessionId });
  });

  it('anahtar rotasyonu: eski anahtarla imzalanmış token listede kaldıkça geçerli', async () => {
    const old = await createTokenService({
      ...opts,
      privateJwk: k1.privateJwk,
      publicJwks: [k1.publicJwk],
    });
    const { token } = await old.signAccess({ userId, sessionId });
    const rotated = await createTokenService({
      ...opts,
      privateJwk: k2.privateJwk,
      publicJwks: [k2.publicJwk, k1.publicJwk],
    });
    expect((await rotated.verifyAccess(token)).userId).toBe(userId);
    const removed = await createTokenService({
      ...opts,
      privateJwk: k2.privateJwk,
      publicJwks: [k2.publicJwk],
    });
    await expect(removed.verifyAccess(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('süresi dolmuş → TOKEN_EXPIRED; bozuk/başka kitle → UNAUTHENTICATED', async () => {
    const svc = await createTokenService({
      ...opts,
      privateJwk: k1.privateJwk,
      publicJwks: [k1.publicJwk],
    });
    const key = await importJWK(k1.privateJwk, 'EdDSA');
    const now = Math.floor(Date.now() / 1000);
    const sign = (claims, iat, exp) =>
      new SignJWT({ sid: sessionId, ...claims })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
        .setSubject(userId)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(key);

    const expired = await sign({ iss: opts.issuer, aud: opts.audience }, now - 1000, now - 60);
    await expect(svc.verifyAccess(expired)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });

    const otherAud = await sign({ iss: opts.issuer, aud: 'mochifast-admin' }, now, now + 60);
    await expect(svc.verifyAccess(otherAud)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    await expect(svc.verifyAccess('local-onboarding-session')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('imzalama anahtarının açık anahtarı listede yoksa başlamaz', async () => {
    await expect(
      createTokenService({ ...opts, privateJwk: k1.privateJwk, publicJwks: [k2.publicJwk] }),
    ).rejects.toThrow(/JWT_PUBLIC_JWKS/);
  });
});

describe('refresh token', () => {
  it('rt_ önekli, 256 bit; hash deterministik', () => {
    const rt = newRefreshToken();
    expect(rt).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(newRefreshToken()).not.toBe(rt);
    expect(hashRefreshToken(rt)).toBe(hashRefreshToken(rt));
    expect(hashRefreshToken(rt)).toMatch(/^[0-9a-f]{64}$/);
  });
});
