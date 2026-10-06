import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, importJWK } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { appleTokenContext } from '../../src/modules/auth/auth.service.js';
import { GUEST_MERGE_STEPS } from '../../src/modules/auth/guest-merge.js';
import { toBin } from '../../src/shared/ids.js';
import { BUNDLE_ID, GOOGLE_CLIENT, createIntegrationApp, sha256 } from '../helpers/app.js';
import { TEST_SECRETS } from '../helpers/infra.js';

const mysqlUrl = inject('mysqlUrl');

describe.skipIf(!mysqlUrl)('auth akışları (gerçek MySQL)', () => {
  let ctx;
  let db;
  let app;
  let crypto;
  let apple;
  let google;
  let appleExchanges;
  let call;
  let guest;
  let appleLogin;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    ({ db, app, crypto, apple, google, appleExchanges, call, guest, appleLogin } = ctx);
  });

  afterEach(() => {
    GUEST_MERGE_STEPS.length = 0;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const userRow = (id) =>
    db.one('SELECT status, is_guest, display_name, email FROM users WHERE id = :id', {
      id: toBin(id),
    });

  it('misafir: yeni kullanıcı 201, aynı installId → aynı kullanıcı 200 + yeni token', async () => {
    const installId = randomUUID();
    const first = await guest(installId);
    expect(first.statusCode).toBe(201);
    const a = first.json().data;
    expect(a.user).toMatchObject({ isGuest: true, isPremium: false, isAnsweredQuestions: false });
    expect(a.token.expiresIn).toBe(900);
    expect(a.token.refreshToken).toMatch(/^rt_/);

    const second = await guest(installId);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.user.id).toBe(a.user.id);
    expect(second.json().data.token.refreshToken).not.toBe(a.token.refreshToken);

    const devices = await db.many(
      'SELECT platform, locale, timezone FROM devices WHERE user_id = :id',
      {
        id: toBin(a.user.id),
      },
    );
    expect(devices).toEqual([{ platform: 'ios', locale: 'tr', timezone: 'Europe/Istanbul' }]);
    const audit = await db.many(
      'SELECT action FROM audit_logs WHERE actor_id = :id ORDER BY created_at, action',
      { id: toBin(a.user.id) },
    );
    expect(audit.map((r) => r.action)).toEqual(['auth.guest_created', 'auth.login']);
  });

  it('misafir: installId başına saatte 5 → 6. istek 429', async () => {
    const installId = randomUUID();
    for (let i = 0; i < 5; i += 1) expect((await guest(installId)).statusCode).toBeLessThan(300);
    const limited = await guest(installId);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('şema: geçersiz installId/platform → 400', async () => {
    const res = await call('POST', '/auth/guest', { body: { installId: 'abc', platform: 'web' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('korumalı uç: token yok / sahte token → 401 UNAUTHENTICATED; süresi dolmuş → TOKEN_EXPIRED', async () => {
    expect((await call('GET', '/auth/sessions')).json().error.code).toBe('UNAUTHENTICATED');
    const fake = await call('GET', '/auth/sessions', { token: 'local-onboarding-session' });
    expect(fake.statusCode).toBe(401);
    expect(fake.json().error.code).toBe('UNAUTHENTICATED');

    const { user } = (await guest()).json().data;
    const key = await importJWK(JSON.parse(TEST_SECRETS.JWT_PRIVATE_JWK), 'EdDSA');
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ sid: randomUUID() })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-1' })
      .setSubject(user.id)
      .setIssuer('api.mochifast.app')
      .setAudience('mochifast-app')
      .setIssuedAt(now - 1000)
      .setExpirationTime(now - 100)
      .sign(key);
    const res = await call('GET', '/auth/sessions', { token: expired });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TOKEN_EXPIRED');
  });

  it('refresh: rotasyon; eski access token süresi dolana kadar çalışır', async () => {
    const { token } = (await guest()).json().data;
    const res = await call('POST', '/auth/refresh', { body: { refreshToken: token.refreshToken } });
    expect(res.statusCode).toBe(200);
    const next = res.json().data.token;
    expect(next.refreshToken).not.toBe(token.refreshToken);
    expect((await call('GET', '/auth/sessions', { token: next.accessToken })).statusCode).toBe(200);
    expect((await call('GET', '/auth/sessions', { token: token.accessToken })).statusCode).toBe(
      200,
    );
  });

  it('refresh: aynı token ile paralel istekler aynı yeni çifti alır', async () => {
    const { token } = (await guest()).json().data;
    const body = { refreshToken: token.refreshToken };
    const [a, b] = await Promise.all([
      call('POST', '/auth/refresh', { body }),
      call('POST', '/auth/refresh', { body }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().data.token).toEqual(b.json().data.token);
  });

  it('refresh: kullanılmış token tekrar gelirse tüm aile iptal → 401 REFRESH_REUSED', async () => {
    const { token } = (await guest()).json().data;
    const next = (
      await call('POST', '/auth/refresh', { body: { refreshToken: token.refreshToken } })
    ).json().data.token;
    // 10 sn tolerans penceresini geçmiş gibi yap.
    await db.run(
      "UPDATE sessions SET revoked_at = NOW(3) - INTERVAL 1 MINUTE WHERE revoke_reason = 'rotated'",
    );

    const reused = await call('POST', '/auth/refresh', {
      body: { refreshToken: token.refreshToken },
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.json().error.code).toBe('REFRESH_REUSED');

    // Saldırgan da meşru istemci de dışarıda: yeni refresh ve access token geçersiz.
    const after = await call('POST', '/auth/refresh', {
      body: { refreshToken: next.refreshToken },
    });
    expect(after.json().error.code).toBe('REFRESH_REUSED');
    const access = await call('GET', '/auth/sessions', { token: next.accessToken });
    expect(access.statusCode).toBe(401);
  });

  it('refresh: bilinmeyen token → 401 UNAUTHENTICATED', async () => {
    const res = await call('POST', '/auth/refresh', {
      body: { refreshToken: `rt_${randomBytes(32).toString('base64url')}` },
    });
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('Apple: yeni hesap 201, tekrar giriş 200 aynı kullanıcı; Apple refresh token şifreli saklanır', async () => {
    const sub = `apple-${randomUUID()}`;
    const first = await appleLogin({ sub, code: 'code-123' });
    expect(first.statusCode).toBe(201);
    const data = first.json().data;
    expect(data).toMatchObject({ isNewUser: true, linkedFromGuest: false });
    expect(data.user).toMatchObject({ isGuest: false, name: 'Atilla E.' });

    const second = await appleLogin({ sub });
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ isNewUser: false, user: { id: data.user.id } });

    expect(appleExchanges.at(-1).body).toMatchObject({ code: 'code-123', client_id: BUNDLE_ID });
    const row = await db.one(
      "SELECT apple_refresh_token_enc FROM auth_identities WHERE provider = 'apple' AND provider_subject = :sub",
      { sub },
    );
    expect(row.apple_refresh_token_enc.toString()).not.toContain('apple-refresh-xyz');
    expect(crypto.decrypt(row.apple_refresh_token_enc, appleTokenContext(data.user.id))).toBe(
      'apple-refresh-xyz',
    );
  });

  it('Apple: nonce eşleşmezse 401', async () => {
    const idToken = await apple.sign(
      { sub: 'x', nonce: sha256('baska') },
      { iss: 'https://appleid.apple.com', aud: BUNDLE_ID },
    );
    const res = await call('POST', '/auth/register', {
      body: { provider: 'apple', idToken, nonce: 'gercek-nonce' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('Google: aud listede olmalı', async () => {
    const sub = `google-${randomUUID()}`;
    const ok = await call('POST', '/auth/register', {
      body: {
        provider: 'google',
        idToken: await google.sign(
          { sub, email: 'a@gmail.com', email_verified: true, name: 'Ayşe' },
          { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT },
        ),
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.user).toMatchObject({ name: 'Ayşe', email: 'a@gmail.com' });

    const wrongAud = await call('POST', '/auth/register', {
      body: {
        provider: 'google',
        idToken: await google.sign(
          { sub },
          { iss: 'https://accounts.google.com', aud: 'baska-app' },
        ),
      },
    });
    expect(wrongAud.statusCode).toBe(401);
  });

  it('misafir yükseltme: aynı userId, misafir token ve installId artık geçersiz', async () => {
    const installId = randomUUID();
    const g = (await guest(installId)).json().data;
    const res = await appleLogin({ sub: `apple-${randomUUID()}`, token: g.token.accessToken });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      isNewUser: false,
      linkedFromGuest: true,
      user: { id: g.user.id, isGuest: false, name: 'Atilla E.' },
    });
    expect((await call('GET', '/auth/sessions', { token: g.token.accessToken })).statusCode).toBe(
      401,
    );

    // Aynı installId ile misafir girişi yükseltilmiş hesaba GİRMEZ; yeni misafir oluşur.
    const again = await guest(installId);
    expect(again.statusCode).toBe(201);
    expect(again.json().data.user.id).not.toBe(g.user.id);
  });

  it('çakışma: misafir + başka hesaba bağlı Apple → 409; mergeGuest:false ile hesaba geçilir', async () => {
    const sub = `apple-${randomUUID()}`;
    const owner = (await appleLogin({ sub })).json().data.user;
    const g = (await guest()).json().data;

    const conflict = await appleLogin({ sub, token: g.token.accessToken });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({
      code: 'ACCOUNT_LINK_CONFLICT',
      details: { options: ['switch_account', 'merge'] },
    });
    expect((await userRow(g.user.id)).status).toBe('active');

    const switched = await appleLogin({ sub, token: g.token.accessToken, mergeGuest: false });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().data).toMatchObject({ mergedFromGuest: false, user: { id: owner.id } });
    expect((await userRow(g.user.id)).status).toBe('pending_deletion');
    const old = await call('GET', '/auth/sessions', { token: g.token.accessToken });
    expect(old.statusCode).toBe(410);
  });

  it('çakışma: mergeGuest:true birleştirme adımlarını aynı transaction’da çalıştırır', async () => {
    const sub = `apple-${randomUUID()}`;
    const owner = (await appleLogin({ sub })).json().data.user;
    const g = (await guest()).json().data;
    const calls = [];
    GUEST_MERGE_STEPS.push(async (conn, { fromUserId, toUserId }) => {
      calls.push({ fromUserId, toUserId, inTx: Boolean(conn) });
    });

    const merged = await appleLogin({ sub, token: g.token.accessToken, mergeGuest: true });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().data.mergedFromGuest).toBe(true);
    expect(calls).toEqual([{ fromUserId: g.user.id, toUserId: owner.id, inTx: true }]);
  });

  it('çıkış: oturum + refresh geçersiz, cihazın push token’ı silinir', async () => {
    const installId = randomUUID();
    const { token, user } = (await guest(installId)).json().data;
    await db.run("UPDATE devices SET push_token = 'fcm-token' WHERE install_id = :installId", {
      installId,
    });

    const res = await call('POST', '/auth/logout', { token: token.accessToken, body: {} });
    expect(res.statusCode).toBe(200);
    expect((await call('GET', '/auth/sessions', { token: token.accessToken })).statusCode).toBe(
      401,
    );
    const refresh = await call('POST', '/auth/refresh', {
      body: { refreshToken: token.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
    const device = await db.one('SELECT push_token FROM devices WHERE user_id = :id', {
      id: toBin(user.id),
    });
    expect(device.push_token).toBeNull();
  });

  it('oturumlar: liste (current işaretli) ve uzaktan kapatma; başkasının oturumu 404', async () => {
    const installId = randomUUID();
    const a = (await guest(installId)).json().data;
    const b = (await guest(installId)).json().data;

    const list = (await call('GET', '/auth/sessions', { token: a.token.accessToken })).json().data;
    expect(list.items).toHaveLength(2);
    expect(list.items.filter((s) => s.current)).toHaveLength(1);
    const other = list.items.find((s) => !s.current);

    const stranger = (await guest()).json().data;
    const notMine = await call('DELETE', `/auth/sessions/${other.id}`, {
      token: stranger.token.accessToken,
    });
    expect(notMine.statusCode).toBe(404);

    expect(
      (await call('DELETE', `/auth/sessions/${other.id}`, { token: a.token.accessToken }))
        .statusCode,
    ).toBe(200);
    expect((await call('GET', '/auth/sessions', { token: b.token.accessToken })).statusCode).toBe(
      401,
    );
    expect((await call('GET', '/auth/sessions', { token: a.token.accessToken })).statusCode).toBe(
      200,
    );
  });

  it('çıkış allDevices: kullanıcının tüm oturumları kapanır', async () => {
    const installId = randomUUID();
    const a = (await guest(installId)).json().data;
    const b = (await guest(installId)).json().data;
    await call('POST', '/auth/logout', { token: a.token.accessToken, body: { allDevices: true } });
    expect((await call('GET', '/auth/sessions', { token: b.token.accessToken })).statusCode).toBe(
      401,
    );
  });

  it('banlanan kullanıcı → 403 (cache temizlenince)', async () => {
    const { token, user } = (await guest()).json().data;
    await db.run("UPDATE users SET status = 'banned' WHERE id = :id", { id: toBin(user.id) });
    await app.deps.cache.delPrefix(`sess:${user.id}:`);
    const res = await call('GET', '/auth/sessions', { token: token.accessToken });
    expect(res.statusCode).toBe(403);
    expect((await guest()).statusCode).toBe(201); // başka kullanıcı etkilenmez
  });
});
