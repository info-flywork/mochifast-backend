import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { accountJobs } from '../../src/jobs/account.jobs.js';
import { EXPORT_EXCLUDED, EXPORT_TABLES } from '../../src/modules/account/export.js';
import { ownerKey } from '../../src/modules/media/media.pipeline.js';
import { newId, toBin } from '../../src/shared/ids.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const TZ = 'Europe/Istanbul';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const onboardingBody = {
  schemaVersion: 1,
  goal: 'loseWeight',
  gender: 'woman',
  weightKg: 74,
  goalWeightKg: 64,
  heightCm: 172,
  age: 29,
  diet: 'everything',
  foodLoves: ['eggs'],
  weightHistory: 'firstTime',
  fastingReason: 'trip',
  planCode: '16_8',
  mealWindow: { start: '07:00', end: '19:00' },
  consents: { terms: '2026-10', privacy: '2026-10', healthData: true },
};

function multipart(buffer) {
  const boundary = `----mochi${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.jpg"\r\n` +
        'Content-Type: image/jpeg\r\n\r\n',
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const photo = () =>
  sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    .jpeg()
    .toBuffer();

const listFiles = (dir) =>
  readdir(dir, { recursive: true, withFileTypes: true }).then(
    (entries) => entries.filter((d) => d.isFile()),
    (err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    },
  );

describe.skipIf(!mysqlUrl)('hesap: silme, dışa aktarma, rıza, saklama (gerçek MySQL)', () => {
  let ctx;
  let call;
  let jobs;
  const firebaseDeleted = [];

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    ({ call } = ctx);
    jobs = accountJobs({
      db: ctx.db,
      storage: ctx.storage,
      config: ctx.config,
      logger: silent,
      crypto: ctx.crypto,
      firebaseUsers: {
        enabled: true,
        async deleteUser(uid) {
          firebaseDeleted.push(uid);
          return true;
        },
      },
      revenuecat: {
        enabled: true,
        async deleteSubscriber(id) {
          ctx.revenuecatApi.calls.push({ url: `/subscribers/${id}`, method: 'DELETE' });
        },
      },
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const upload = (token, buffer) => {
    const { payload, headers } = multipart(buffer);
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/media?purpose=mealPhoto',
      payload,
      headers: { ...headers, authorization: `Bearer ${token}` },
    });
  };
  const runJob = (name, payload) =>
    jobs[name]({ payload, attempt: 1, maxAttempts: 3, id: 0, name });

  /** Apple ile kayıtlı, onboard edilmiş, birçok domainde verisi olan kullanıcı. */
  async function richUser() {
    const uid = `apple-${randomUUID()}`;
    const res = await ctx.firebaseLogin({ uid });
    expect(res.statusCode).toBe(201);
    const { token, user } = res.json().data;
    const t = token.accessToken;
    expect(
      (
        await call('POST', '/user/onboarding', {
          token: t,
          body: onboardingBody,
          headers: { 'x-timezone': TZ },
        })
      ).statusCode,
    ).toBe(200);
    const media = (await upload(t, await photo())).json().data.media;
    expect(
      (
        await call('POST', '/meals', {
          token: t,
          body: {
            id: newId(),
            kind: 'meal',
            title: 'Mercimek',
            notes: 'Gizli not',
            kcal: 420,
            photoMediaId: media.id,
          },
        })
      ).statusCode,
    ).toBe(201);
    await call('POST', '/weights', { token: t, body: { weightKg: 72.4 } });
    await call('POST', '/water', { token: t, body: { amountMl: 250 } });
    await call('POST', '/fasts', { token: t, body: {} });
    await call('PUT', '/devices/current', {
      token: t,
      body: {
        installId: randomUUID(),
        platform: 'ios',
        pushToken: `fcm-${uid}`,
        pushEnabled: true,
      },
    });
    return { uid, token: t, refreshToken: token.refreshToken, userId: user.id, mediaId: media.id };
  }

  /** Kullanıcıya ait satır kalan tablolar (silme talebi kaydı bilinçli olarak kalır). */
  async function leftovers(userId) {
    const tables = await ctx.db.many(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND column_name IN ('user_id', 'owner_user_id')
          AND table_name <> 'account_deletion_requests'`,
    );
    const left = {};
    for (const { t, c } of tables) {
      const row = await ctx.db.one(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = :id`, {
        id: toBin(userId),
      });
      if (Number(row.n) > 0) left[t] = Number(row.n);
    }
    const users = await ctx.db.one('SELECT COUNT(*) AS n FROM users WHERE id = :id', {
      id: toBin(userId),
    });
    if (Number(users.n) > 0) left.users = Number(users.n);
    const audit = await ctx.db.one(
      `SELECT COUNT(*) AS n FROM audit_logs
        WHERE (actor_type = 'user' AND actor_id = :id) OR (entity_type = 'user' AND entity_id = :uid)`,
      { id: toBin(userId), uid: userId },
    );
    if (Number(audit.n) > 0) left.audit_logs = Number(audit.n);
    return left;
  }

  // ── Silme ───────────────────────────────────────────────────────────
  it('silme talebi: oturumlar kapanır; süre içinde giriş 409, restoreAccount ile geri açılır', async () => {
    const u = await richUser();
    const del = await call('DELETE', '/user/me', { token: u.token, body: { reason: 'test' } });
    expect(del.statusCode).toBe(202);
    const { scheduledFor, hasActiveSubscription } = del.json().data;
    expect(new Date(scheduledFor).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(hasActiveSubscription).toBe(false);

    // Tekrar çağrı aynı talep; token artık geçersiz (410), refresh de iptal.
    expect((await call('GET', '/user/me', { token: u.token })).statusCode).toBe(410);
    const refresh = await call('POST', '/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(refresh.statusCode).toBe(401);
    const device = await ctx.db.one(
      'SELECT COUNT(*) AS n FROM devices WHERE user_id = :id AND push_token IS NOT NULL',
      { id: toBin(u.userId) },
    );
    expect(Number(device.n)).toBe(0);

    const again = await ctx.firebaseLogin({ uid: u.uid });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({
      code: 'ACCOUNT_PENDING_DELETION',
      details: { scheduledFor, options: ['restore'] },
    });

    const restored = await call('POST', '/auth/register', {
      body: {
        provider: 'firebase',
        idToken: await ctx.firebase.sign({ uid: u.uid }),
        deviceId: randomUUID(),
        platform: 'ios',
        restoreAccount: true,
      },
    });
    expect(restored.statusCode).toBe(200);
    const me = await call('GET', '/user/me', {
      token: restored.json().data.token.accessToken,
    });
    expect(me.statusCode).toBe(200);
    const req = await ctx.db.one(
      'SELECT status FROM account_deletion_requests WHERE user_id = :id',
      { id: toBin(u.userId) },
    );
    expect(req.status).toBe('cancelled');
  });

  it('kabul kriteri: süre dolunca kullanıcıya ait hiçbir satır ve dosya kalmaz', async () => {
    const u = await richUser();
    const prefixDir = join(
      ctx.mediaDir,
      'private',
      'u',
      ownerKey(u.userId, ctx.config.media.pathSecret),
    );
    expect((await listFiles(prefixDir)).length).toBeGreaterThan(0);
    expect(Object.keys(await leftovers(u.userId)).length).toBeGreaterThan(5);

    expect((await call('DELETE', '/user/me', { token: u.token })).statusCode).toBe(202);
    // Süre dolmadan süpürme bir şey yapmaz.
    await runJob('accountDeletionSweep', {});
    const pending = await ctx.db.one(
      'SELECT id, status FROM account_deletion_requests WHERE user_id = :id',
      { id: toBin(u.userId) },
    );
    expect(pending.status).toBe('scheduled');

    await ctx.db.run(
      'UPDATE account_deletion_requests SET scheduled_for = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE user_id = :id',
      { id: toBin(u.userId) },
    );
    await runJob('accountDeletionSweep', {});
    const job = await ctx.db.one(
      "SELECT CAST(payload AS CHAR) AS payload FROM jobs WHERE queue = 'account' AND name = 'accountDelete' ORDER BY id DESC LIMIT 1",
    );
    await runJob('accountDelete', JSON.parse(job.payload));

    expect(await leftovers(u.userId)).toEqual({});
    expect(await listFiles(prefixDir)).toEqual([]);
    expect(firebaseDeleted).toContain(u.uid);
    expect(ctx.revenuecatApi.calls).toContainEqual({
      url: `/subscribers/${u.userId}`,
      method: 'DELETE',
    });
    const done = await ctx.db.one(
      'SELECT status, completed_at FROM account_deletion_requests WHERE user_id = :id',
      { id: toBin(u.userId) },
    );
    expect(done.status).toBe('completed');
    expect(done.completed_at).not.toBeNull();
    // Silinen hesaba giriş: yeni kullanıcı oluşur (eski kimlik yok).
    expect((await ctx.firebaseLogin({ uid: u.uid })).statusCode).toBe(201);
  });

  // ── Dışa aktarma ────────────────────────────────────────────────────
  it('her kullanıcı tablosu ya dışa aktarılır ya da bilinçli olarak dışarıda bırakılır', async () => {
    const tables = await ctx.db.many(
      `SELECT DISTINCT table_name AS t FROM information_schema.columns
        WHERE table_schema = DATABASE() AND column_name = 'user_id'`,
    );
    const covered = new Set([
      ...EXPORT_TABLES.map((s) => s.table),
      ...Object.keys(EXPORT_EXCLUDED),
    ]);
    expect(tables.map((r) => r.t).filter((t) => !covered.has(t))).toEqual([]);
  });

  it('kabul kriteri: zip tüm domainleri, çözülmüş notları ve fotoğrafları içerir; 7 gün sonra erişilemez', async () => {
    const u = await richUser();
    const first = await call('POST', '/user/me/export', { token: u.token });
    expect(first.statusCode).toBe(202);
    const { id } = first.json().data.export;
    expect(first.json().data.export).toMatchObject({ status: 'queued', url: null });
    // Günde 1: aynı talep döner.
    expect((await call('POST', '/user/me/export', { token: u.token })).json().data.export.id).toBe(
      id,
    );

    await runJob('dataExport', { exportId: id });
    const ready = (await call('GET', `/user/me/export/${id}`, { token: u.token })).json().data
      .export;
    expect(ready).toMatchObject({ id, status: 'ready' });
    expect(ready.url).toMatch(
      /^http:\/\/media\.test\/media-files\/u\/.+\/exports\/.+\.zip\?token=/,
    );
    expect(new Date(ready.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    const url = new URL(ready.url);
    const file = await ctx.app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(file.statusCode).toBe(200);
    const zip = unzipSync(new Uint8Array(file.rawPayload));
    const json = (name) => JSON.parse(strFromU8(zip[`data/${name}.json`]));

    for (const spec of EXPORT_TABLES) expect(zip[`data/${spec.file}.json`]).toBeDefined();
    expect(json('account')).toMatchObject({ id: u.userId });
    expect(json('meals')[0]).toMatchObject({ title: 'Mercimek', notes: 'Gizli not', kcal: 420 });
    expect(json('meals')[0]).not.toHaveProperty('notes_enc');
    expect(json('weights')).toHaveLength(2); // onboarding + 72,4
    expect(json('devices')[0]).not.toHaveProperty('push_token');
    expect(json('sessions')[0]).not.toHaveProperty('token_hash');
    expect(strFromU8(zip['csv/meals.csv'])).toContain('Gizli not');
    expect(zip[`photos/meals/${u.mediaId}.webp`]?.length).toBeGreaterThan(500);
    expect(zip['README.txt']).toBeDefined();

    // Bildirim planlandı (inbox + push).
    const notif = await ctx.db.one(
      "SELECT CAST(params AS CHAR) AS params FROM scheduled_notifications WHERE user_id = :id AND type = 'data_export_ready'",
      { id: toBin(u.userId) },
    );
    expect(JSON.parse(notif.params)).toEqual({ exportId: id });

    // Başkası göremez.
    const other = (await ctx.guest()).json().data.token.accessToken;
    expect((await call('GET', `/user/me/export/${id}`, { token: other })).statusCode).toBe(404);

    // 7 gün sonra: dosya silinir, link verilmez.
    await ctx.db.run(
      'UPDATE data_export_requests SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = :id',
      { id: toBin(id) },
    );
    await runJob('dataExportExpire', {});
    const expired = (await call('GET', `/user/me/export/${id}`, { token: u.token })).json().data
      .export;
    expect(expired).toMatchObject({ status: 'expired', url: null });
    const gone = await ctx.app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(gone.statusCode).toBe(404);
  });

  // ── Rıza ────────────────────────────────────────────────────────────
  it('rıza: sağlık verisi geri çekilince kayıt yazılamaz (silme serbest); pazarlama kapanır', async () => {
    const u = await richUser();
    const weight = await call('POST', '/weights', { token: u.token, body: { weightKg: 71.9 } });
    expect(weight.statusCode).toBe(201);
    const weightId = weight.json().data.entry.id;

    const consent = (type, granted) =>
      call('POST', '/user/consents', {
        token: u.token,
        body: { type, version: '2026-10', granted },
      });
    expect((await consent('healthData', false)).statusCode).toBe(200);
    const blocked = await call('POST', '/weights', { token: u.token, body: { weightKg: 71.5 } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatchObject({
      code: 'CONSENT_REQUIRED',
      details: { consent: 'healthData' },
    });
    expect(
      (await call('POST', '/water', { token: u.token, body: { amountMl: 200 } })).statusCode,
    ).toBe(403);
    expect((await call('DELETE', `/weights/${weightId}`, { token: u.token })).statusCode).toBe(200);
    expect((await consent('healthData', true)).statusCode).toBe(200);
    expect(
      (await call('POST', '/weights', { token: u.token, body: { weightKg: 71.5 } })).statusCode,
    ).toBe(201);

    await call('PATCH', '/user/settings', {
      token: u.token,
      body: { notifications: { marketing: true } },
    });
    await consent('marketingPush', false);
    const settings = (await call('GET', '/user/settings', { token: u.token })).json().data;
    expect(settings.notifications.marketing).toBe(false);
  });

  it('rıza: yasal metin sürümü değişince yeniden onay istenir', async () => {
    const u = await richUser();
    const me = async () => (await call('GET', '/user/me', { token: u.token })).json().data;
    expect((await me()).requiredConsents).toEqual([]);

    await ctx.db.run(
      `UPDATE app_config SET value = JSON_SET(value, '$.termsVersion', '2027-01')
        WHERE config_key = 'legal'`,
    );
    await ctx.app.deps.cache.delPrefix('');
    expect((await me()).requiredConsents).toEqual(['terms']);
    await call('POST', '/user/consents', {
      token: u.token,
      body: { type: 'terms', version: '2027-01', granted: true },
    });
    expect((await me()).requiredConsents).toEqual([]);
    await ctx.db.run(
      `UPDATE app_config SET value = JSON_SET(value, '$.termsVersion', '2026-10')
        WHERE config_key = 'legal'`,
    );
    await ctx.app.deps.cache.delPrefix('');
  });

  // ── Saklama ─────────────────────────────────────────────────────────
  it('saklama: inaktif misafir ve birleştirmede kapanan misafir silinmeye planlanır; eski kayıtlar silinir', async () => {
    const idle = (await ctx.guest(randomUUID(), { timezone: TZ })).json().data;
    const active = (await ctx.guest(randomUUID(), { timezone: TZ })).json().data;
    await ctx.db.run(
      `UPDATE users SET created_at = DATE_SUB(NOW(3), INTERVAL 120 DAY), last_active_at = NULL
        WHERE id IN (:a, :b)`,
      { a: toBin(idle.user.id), b: toBin(active.user.id) },
    );
    // Etkin misafir: istek last_active_at'i yazar (saatte bir).
    await call('GET', '/user/me', { token: active.token.accessToken });
    await new Promise((r) => setTimeout(r, 100));

    // Birleştirme: misafir oturumuyla mevcut hesaba geçiş → misafir kapanır, 30 gün sonra silinir.
    const ownerUid = `apple-${randomUUID()}`;
    expect((await ctx.firebaseLogin({ uid: ownerUid })).statusCode).toBe(201);
    const merging = (await ctx.guest()).json().data;
    const switched = await ctx.firebaseLogin({
      uid: ownerUid,
      token: merging.token.accessToken,
      mergeGuest: false,
    });
    expect(switched.statusCode).toBe(200);
    const retired = await ctx.db.one(
      `SELECT source, TIMESTAMPDIFF(DAY, NOW(3), scheduled_for) AS days
         FROM account_deletion_requests WHERE user_id = :id`,
      { id: toBin(merging.user.id) },
    );
    expect(retired).toMatchObject({ source: 'guest_retired' });
    expect(Number(retired.days)).toBeGreaterThanOrEqual(29);

    // Eski yumuşak silinmiş kayıt ve eski denetim izi.
    const u = await richUser();
    const w = await ctx.db.one('SELECT id FROM weight_entries WHERE user_id = :id LIMIT 1', {
      id: toBin(u.userId),
    });
    await ctx.db.run(
      'UPDATE weight_entries SET deleted_at = DATE_SUB(NOW(3), INTERVAL 31 DAY) WHERE id = :id',
      { id: w.id },
    );
    await ctx.db.run(
      `INSERT INTO audit_logs (id, actor_type, action, created_at)
       VALUES (:id, 'system', 'test.old', DATE_SUB(NOW(3), INTERVAL 14 MONTH))`,
      { id: toBin(newId()) },
    );

    await runJob('accountRetention', {});

    const status = async (id) =>
      (await ctx.db.one('SELECT status FROM users WHERE id = :id', { id: toBin(id) })).status;
    expect(await status(idle.user.id)).toBe('pending_deletion');
    expect(await status(active.user.id)).toBe('active');
    const req = await ctx.db.one(
      'SELECT source, status, scheduled_for <= NOW(3) AS due FROM account_deletion_requests WHERE user_id = :id',
      { id: toBin(idle.user.id) },
    );
    expect(req).toMatchObject({ source: 'inactive_guest', status: 'scheduled' });
    expect(Number(req.due)).toBe(1);
    expect(
      (await ctx.db.one('SELECT COUNT(*) AS n FROM weight_entries WHERE id = :id', { id: w.id })).n,
    ).toBe(0);
    expect(
      Number(
        (await ctx.db.one("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'test.old'")).n,
      ),
    ).toBe(0);
    expect((await call('GET', '/user/me', { token: idle.token.accessToken })).statusCode).toBe(410);
  });
});
