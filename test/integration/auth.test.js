import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, importJWK } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { GUEST_MERGE_STEPS } from '../../src/modules/auth/guest-merge.js';
import { toBin } from '../../src/shared/ids.js';
import { createIntegrationApp } from '../helpers/app.js';
import { TEST_SECRETS } from '../helpers/infra.js';

const mysqlUrl = inject('mysqlUrl');

describe.skipIf(!mysqlUrl)('auth akışları (gerçek MySQL)', () => {
  let ctx;
  let db;
  let app;
  let firebase;
  let call;
  let guest;
  let firebaseLogin;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    ({ db, app, firebase, call, guest, firebaseLogin } = ctx);
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

  it('Firebase: yeni hesap 201, tekrar 200; aynı uid başka yöntemle de aynı hesap', async () => {
    const uid = `fb-${randomUUID()}`;
    const first = await firebaseLogin({
      uid,
      email: 'x@privaterelay.appleid.com',
      fullName: { givenName: 'Atilla', familyName: 'E.' },
    });
    expect(first.statusCode).toBe(201);
    const data = first.json().data;
    expect(data).toMatchObject({ isNewUser: true, linkedFromGuest: false });
    expect(data.user).toMatchObject({
      isGuest: false,
      name: 'Atilla E.',
      email: 'x@privaterelay.appleid.com',
    });

    // Firebase'de aynı uid'ye Google da bağlanmış olabilir: kimlik uid'dir.
    const second = await firebaseLogin({ uid, provider: 'google.com', name: 'Başka Ad' });
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({
      isNewUser: false,
      user: { id: data.user.id, name: 'Atilla E.' },
    });
    const row = await db.one(
      "SELECT sign_in_provider FROM auth_identities WHERE provider = 'firebase' AND provider_subject = :uid",
      { uid },
    );
    expect(row.sign_in_provider).toBe('google.com');
  });

  it('Firebase: ad gönderilmezse token’daki ad; /firebase takma adı', async () => {
    const idToken = await firebase.sign({
      uid: `fb-${randomUUID()}`,
      provider: 'google.com',
      name: 'Ayşe',
    });
    const res = await call('POST', '/auth/firebase', { body: { provider: 'firebase', idToken } });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.user.name).toBe('Ayşe');
  });

  it('Firebase: başka proje, yanlış issuer, süresi dolmuş, anonim giriş reddedilir', async () => {
    const register = (idToken) =>
      call('POST', '/auth/register', { body: { provider: 'firebase', idToken } });
    const uid = `fb-${randomUUID()}`;

    expect((await register(await firebase.sign({ uid }, { aud: 'baska-proje' }))).statusCode).toBe(
      401,
    );
    const wrongIssuer = await firebase.sign(
      { uid },
      { iss: 'https://securetoken.google.com/baska-proje' },
    );
    expect((await register(wrongIssuer)).statusCode).toBe(401);
    const expired = await firebase.sign({ uid }, { exp: Math.floor(Date.now() / 1000) - 120 });
    expect((await register(expired)).statusCode).toBe(401);
    expect((await register('local-onboarding-session')).statusCode).toBe(401);

    // Misafir Firebase'de değil, backend'de (cihaz başına tek misafir).
    const anonymous = await register(await firebase.sign({ uid, provider: 'anonymous' }));
    expect(anonymous.statusCode).toBe(400);
    expect(anonymous.json().error.details).toEqual({ reason: 'provider_not_allowed' });
  });

  it('misafir yükseltme: aynı userId, misafir token ve installId artık geçersiz', async () => {
    const installId = randomUUID();
    const g = (await guest(installId)).json().data;
    const res = await firebaseLogin({
      uid: `fb-${randomUUID()}`,
      token: g.token.accessToken,
      fullName: { givenName: 'Atilla', familyName: 'E.' },
    });
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

  it('çakışma: misafir + başka hesaba bağlı Firebase kimliği → 409; mergeGuest:false ile hesaba geçilir', async () => {
    const uid = `fb-${randomUUID()}`;
    const owner = (await firebaseLogin({ uid })).json().data.user;
    const g = (await guest()).json().data;

    const conflict = await firebaseLogin({ uid, token: g.token.accessToken });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({
      code: 'ACCOUNT_LINK_CONFLICT',
      details: { options: ['switch_account', 'merge'] },
    });
    expect((await userRow(g.user.id)).status).toBe('active');

    const switched = await firebaseLogin({ uid, token: g.token.accessToken, mergeGuest: false });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().data).toMatchObject({ mergedFromGuest: false, user: { id: owner.id } });
    expect((await userRow(g.user.id)).status).toBe('pending_deletion');
    const old = await call('GET', '/auth/sessions', { token: g.token.accessToken });
    expect(old.statusCode).toBe(410);
  });

  it('çakışma: mergeGuest:true birleştirme adımlarını aynı transaction’da çalıştırır', async () => {
    const uid = `fb-${randomUUID()}`;
    const owner = (await firebaseLogin({ uid })).json().data.user;
    const g = (await guest()).json().data;
    const calls = [];
    GUEST_MERGE_STEPS.push(async (conn, { fromUserId, toUserId }) => {
      calls.push({ fromUserId, toUserId, inTx: Boolean(conn) });
    });

    const merged = await firebaseLogin({ uid, token: g.token.accessToken, mergeGuest: true });
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

  it('yeni misafir: IP başına saatte 10 — /auth/register provider=guest de aynı sınıra takılır', async () => {
    const ip = '198.51.100.77';
    const create = (url, body) =>
      ctx.app.inject({ method: 'POST', url, remoteAddress: ip, payload: body });
    for (let i = 0; i < 5; i += 1) {
      const r = await create('/v1/auth/guest', { installId: randomUUID(), platform: 'ios' });
      expect(r.statusCode).toBe(201);
    }
    for (let i = 0; i < 5; i += 1) {
      const r = await create('/v1/auth/register', {
        provider: 'guest',
        deviceId: randomUUID(),
        platform: 'android',
      });
      expect(r.statusCode).toBe(201);
    }
    const blocked = await create('/v1/auth/register', {
      provider: 'guest',
      deviceId: randomUUID(),
      platform: 'android',
    });
    expect(blocked.statusCode).toBe(429);
    // Var olan misafirin tekrar girişi sınırdan etkilenmez.
    const installId = randomUUID();
    const other = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      remoteAddress: '198.51.100.78',
      payload: { installId, platform: 'ios' },
    });
    expect(other.statusCode).toBe(201);
  });
});
