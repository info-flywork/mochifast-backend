import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { currentStep, totpAt } from '../../src/infra/totp.js';
import { adminAuthFor } from '../../src/modules/admin/admin.routes.js';
import { loadCatalogSeeds, seedCatalog } from '../../src/modules/catalog/catalog.seeder.js';
import { toBin } from '../../src/shared/ids.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const meta = { ip: '127.0.0.1', userAgent: 'test' };

function multipart(buffer) {
  const boundary = `----mochi${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.jpg"\r\n` +
        'Content-Type: image/jpeg\r\n\r\n',
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe.skipIf(!mysqlUrl)('yönetim API: giriş, yetki, içerik, destek, raporlar', () => {
  let ctx;
  let call;
  const admins = {};

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    ({ call } = ctx);
    const auth = adminAuthFor(ctx.app);
    for (const role of ['owner', 'editor', 'support', 'analyst']) {
      const created = await auth.createAdmin({ email: `${role}@mochi.test`, role }, meta);
      admins[role] = { ...created, email: `${role}@mochi.test` };
    }
    // Geçici şifre değişimi ayrı testte; diğer testler için kapatılır.
    await ctx.db.run(
      "UPDATE admin_users SET must_change_password = 0 WHERE email LIKE '%@mochi.test'",
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const code = (secret, offset = 0) => totpAt(secret, currentStep() + offset);
  const login = (role, overrides = {}) =>
    call('POST', '/admin/auth/login', {
      body: {
        email: admins[role].email,
        password: admins[role].password,
        totp: code(admins[role].totp.secret),
        ...overrides,
      },
    });
  /** Testler aynı 30 sn içinde birden çok giriş yapar: tekrar koruması sıfırlanır. */
  async function tokenFor(role) {
    await ctx.db.run('UPDATE admin_users SET totp_last_step = NULL WHERE email = :email', {
      email: admins[role].email,
    });
    const res = await login(role);
    expect(res.statusCode).toBe(200);
    return res.json().data.token;
  }

  // ── Giriş ───────────────────────────────────────────────────────────
  it("giriş: şifre + TOTP; aynı kod ikinci kez kullanılamaz; kullanıcı token'ı geçmez", async () => {
    const first = await login('analyst');
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({
      expiresIn: 3600,
      admin: {
        email: 'analyst@mochi.test',
        role: 'analyst',
        isActive: true,
        mustChangePassword: false,
      },
    });
    const token = first.json().data.token;
    expect((await call('GET', '/admin/auth/me', { token })).json().data.admin.role).toBe('analyst');

    // Aynı TOTP adımı tekrar → 401 (yeniden oynatma).
    expect((await login('analyst')).statusCode).toBe(401);
    // Mobil kullanıcı token'ı admin uçlarında geçmez; admin token'ı kullanıcı uçlarında geçmez.
    const user = (await ctx.guest()).json().data.token.accessToken;
    expect((await call('GET', '/admin/auth/me', { token: user })).statusCode).toBe(401);
    expect((await call('GET', '/user/me', { token })).statusCode).toBe(401);
    // MFA'sız giriş mümkün değil.
    const noTotp = await call('POST', '/admin/auth/login', {
      body: { email: admins.analyst.email, password: admins.analyst.password },
    });
    expect(noTotp.statusCode).toBe(400);
  });

  it('kabul kriteri: 5 hatalı girişte 15 dk kilit; doğru bilgilerle de girilemez', async () => {
    const auth = adminAuthFor(ctx.app);
    const victim = await auth.createAdmin({ email: 'locked@mochi.test', role: 'editor' }, meta);
    const attempt = (password, totp) =>
      call('POST', '/admin/auth/login', {
        body: { email: 'locked@mochi.test', password, totp },
      });
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt('wrong-password', '000000')).statusCode).toBe(401);
    }
    // Kilitli: doğru bilgiler de reddedilir; yanıt bilinmeyen hesapla aynı (hesap varlığı sızmaz).
    const locked = await attempt(victim.password, code(victim.totp.secret));
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error).toEqual(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    expect(locked.json().error.details).toBeUndefined();

    // Owner sıfırlayınca kilit kalkar, yeni şifre + TOTP ile girilir.
    const owner = await tokenFor('owner');
    const reset = await call('POST', `/admin/admins/${victim.admin.id}/reset-credentials`, {
      token: owner,
    });
    expect(reset.statusCode).toBe(200);
    const { password, totp } = reset.json().data;
    const relogin = await attempt(password, code(totp.secret));
    expect(relogin.statusCode).toBe(200);
    expect(relogin.json().data.admin.mustChangePassword).toBe(true);

    // Geçici şifre: yalnızca me/şifre/çıkış açık; değişince eski token iptal, yeni token döner.
    const temp = relogin.json().data.token;
    const blocked = await call('GET', '/admin/catalog', { token: temp });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.details).toEqual({ reason: 'password_change_required' });
    expect((await call('GET', '/admin/auth/me', { token: temp })).statusCode).toBe(200);
    expect(
      (
        await call('POST', '/admin/auth/password', {
          token: temp,
          body: { currentPassword: password, newPassword: 'short' },
        })
      ).statusCode,
    ).toBe(400);
    await new Promise((r) => setTimeout(r, 1100)); // token iat saniye hassasiyetinde
    const changed = await call('POST', '/admin/auth/password', {
      token: temp,
      body: { currentPassword: password, newPassword: 'a much longer passphrase 42' },
    });
    expect(changed.statusCode).toBe(200);
    const fresh = changed.json().data.token;
    expect((await call('GET', '/admin/catalog', { token: fresh })).statusCode).toBe(200);
    expect((await call('GET', '/admin/auth/me', { token: temp })).statusCode).toBe(401);

    // Çıkış: token'lar iptal.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call('POST', '/admin/auth/logout', { token: fresh })).statusCode).toBe(200);
    expect((await call('GET', '/admin/auth/me', { token: fresh })).statusCode).toBe(401);
    // Bilinmeyen e-posta da aynı hata.
    expect(
      (
        await call('POST', '/admin/auth/login', {
          body: { email: 'nobody@mochi.test', password: 'x', totp: '123456' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('yetki: rol dışı uç 403; yönetici yönetimi yalnızca owner; pasif yönetici giremez', async () => {
    const editor = await tokenFor('editor');
    const analyst = await tokenFor('analyst');
    const support = await tokenFor('support');
    expect(
      (await call('POST', '/admin/users/search', { token: editor, body: { q: 'someone@x.com' } }))
        .statusCode,
    ).toBe(403);
    expect((await call('GET', '/admin/catalog', { token: analyst })).statusCode).toBe(403);
    expect((await call('GET', '/admin/reports/overview', { token: support })).statusCode).toBe(403);
    expect((await call('GET', '/admin/admins', { token: editor })).statusCode).toBe(403);

    const owner = await tokenFor('owner');
    const list = await call('GET', '/admin/admins', { token: owner });
    expect(list.json().data.items.map((a) => a.role)).toEqual(
      expect.arrayContaining(['owner', 'editor', 'support', 'analyst']),
    );
    const created = await call('POST', '/admin/admins', {
      token: owner,
      body: { email: 'temp@mochi.test', role: 'support' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.totp.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const tempId = created.json().data.admin.id;
    expect(created.json().data.admin.mustChangePassword).toBe(true);
    await ctx.db.run('UPDATE admin_users SET must_change_password = 0 WHERE id = :id', {
      id: toBin(tempId),
    });
    const tempToken = (
      await call('POST', '/admin/auth/login', {
        body: {
          email: 'temp@mochi.test',
          password: created.json().data.password,
          totp: code(created.json().data.totp.secret),
        },
      })
    ).json().data.token;
    expect((await call('GET', '/admin/auth/me', { token: tempToken })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    await call('PATCH', `/admin/admins/${tempId}`, { token: owner, body: { isActive: false } });
    expect((await call('GET', '/admin/auth/me', { token: tempToken })).statusCode).toBe(401);
    // Owner kendini pasifleştiremez.
    const self = (await call('GET', '/admin/auth/me', { token: owner })).json().data.admin.id;
    expect(
      (await call('PATCH', `/admin/admins/${self}`, { token: owner, body: { isActive: false } }))
        .statusCode,
    ).toBe(409);
  });

  // ── İçerik ──────────────────────────────────────────────────────────
  it('içerik: bölüm dokümanı düzenlenir, uygulamaya yansır; eski sürümle 409; geri alınır; seed ezmez', async () => {
    const editor = await tokenFor('editor');
    const sections = (await call('GET', '/admin/catalog', { token: editor })).json().data.items;
    expect(sections.map((s) => s.section)).toEqual(
      expect.arrayContaining(['content', 'gamification', 'notifications', 'plans', 'labels']),
    );

    const current = (await call('GET', '/admin/catalog/content', { token: editor })).json().data;
    expect(current.source).toBe('seed');
    const doc = structuredClone(current.document);
    doc.faq[0].translations.en.question = 'What is MochiFast, really?';
    const saved = await call('PUT', '/admin/catalog/content', {
      token: editor,
      body: { document: doc, baseVersion: current.version, note: 'faq copy' },
    });
    expect(saved.statusCode).toBe(200);
    const { version } = saved.json().data;
    expect(version).toBe(current.version + 1);

    const faq = await call('GET', '/catalog/faq', { headers: { 'accept-language': 'en' } });
    expect(faq.json().data.items[0].question).toBe('What is MochiFast, really?');

    // Arada başkası kaydetti → 409.
    const stale = await call('PUT', '/admin/catalog/content', {
      token: editor,
      body: { document: doc, baseVersion: current.version },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details).toMatchObject({
      reason: 'stale_version',
      currentVersion: version,
    });

    // Bozuk doküman → 400, hiçbir şey değişmez.
    const broken = await call('PUT', '/admin/catalog/plans', {
      token: editor,
      body: { document: { not: 'an array' }, baseVersion: 1 },
    });
    expect(broken.statusCode).toBe(400);
    const badPlan = await call('PUT', '/admin/catalog/plans', {
      token: editor,
      body: { document: [{ code: 'x' }], baseVersion: 1 },
    });
    expect(badPlan.statusCode).toBe(400);
    const active = await ctx.db.one('SELECT COUNT(*) AS n FROM fasting_plans WHERE is_active = 1');
    expect(Number(active.n)).toBe(21); // geri alındı: hiçbir plan pasifleşmedi

    // Seed artık bu bölümü ezmez.
    const stats = await seedCatalog(ctx.db, await loadCatalogSeeds());
    expect(stats.skipped).toEqual(['content']);
    await ctx.app.deps.cache.del('cfg:app:rows');
    const afterSeed = await call('GET', '/catalog/faq', { headers: { 'accept-language': 'en' } });
    expect(afterSeed.json().data.items[0].question).toBe('What is MochiFast, really?');

    // Geri alma: seed sürümü yeni sürüm olarak uygulanır.
    const rolled = await call('POST', '/admin/catalog/content/rollback', {
      token: editor,
      body: { version: current.version },
    });
    expect(rolled.statusCode).toBe(200);
    const restored = await call('GET', '/catalog/faq', { headers: { 'accept-language': 'en' } });
    expect(restored.json().data.items[0].question).toBe('What is MochiFast?');
    const versions = (
      await call('GET', '/admin/catalog/content/versions', { token: editor })
    ).json().data.items;
    expect(versions[0]).toMatchObject({ version: version + 1, source: 'admin' });
    expect(versions[0].note).toMatch(/rollback/);
  });

  it('app_config: değer yazılır ve uygulamaya yansır; catalog.version korunur', async () => {
    const editor = await tokenFor('editor');
    const set = await call('PUT', '/admin/config/support', {
      token: editor,
      body: { value: { email: 'help@mochi.test' } },
    });
    expect(set.statusCode).toBe(200);
    const app = await call('GET', '/app/config?platform=ios', {});
    expect(app.json().data.support).toEqual({ email: 'help@mochi.test' });
    expect(
      (await call('PUT', '/admin/config/catalog.version', { token: editor, body: { value: 99 } }))
        .statusCode,
    ).toBe(403);
    // Platforma özel değer eklenip kaldırılır.
    await call('PUT', '/admin/config/support', {
      token: editor,
      body: { platform: 'android', value: { email: 'android@mochi.test' } },
    });
    expect((await call('GET', '/app/config?platform=android', {})).json().data.support.email).toBe(
      'android@mochi.test',
    );
    expect(
      (await call('DELETE', '/admin/config/support?platform=android', { token: editor }))
        .statusCode,
    ).toBe(200);
  });

  it("medya: içerik görseli public zone'a yüklenir (kalıcı URL)", async () => {
    const editor = await tokenFor('editor');
    const img = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const { payload, headers } = multipart(img);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/media?purpose=insightCover',
      payload,
      headers: { ...headers, authorization: `Bearer ${editor}` },
    });
    expect(res.statusCode).toBe(201);
    const { media } = res.json().data;
    expect(media.url).toMatch(/\/media-public\/p\/insight_cover\/\d{4}\/\d{2}\/.+_960\.webp$/);
    expect(media.expiresAt).toBeNull();
  });

  // ── Destek ──────────────────────────────────────────────────────────
  it('destek: e-posta ile arama (maskeli), ayrıntı, oturum sonlandırma, premium, silmeyi hızlandırma', async () => {
    const support = await tokenFor('support');
    const login = await ctx.firebaseLogin({
      uid: `google-${randomUUID()}`,
      provider: 'google.com',
      email: 'jane.doe@example.com',
      name: 'Jane Doe',
    });
    const { user, token } = login.json().data;

    const search = await call('POST', '/admin/users/search', {
      token: support,
      body: { q: 'JANE.DOE@example.com' },
    });
    expect(search.json().data.items).toEqual([
      expect.objectContaining({ id: user.id, email: 'j***@e***.com', name: 'J*** D***' }),
    ]);
    // Kısmi arama yok.
    expect(
      (await call('POST', '/admin/users/search', { token: support, body: { q: 'jane' } })).json()
        .data.items,
    ).toEqual([]);
    const detail = (await call('GET', `/admin/users/${user.id}`, { token: support })).json().data
      .user;
    expect(detail).toMatchObject({ id: user.id, isGuest: false, isPremium: false });
    expect(detail.activeSessions).toBe(1);
    expect(JSON.stringify(detail)).not.toContain('jane.doe@example.com');

    expect(
      (
        await call('POST', `/admin/users/${user.id}/premium`, {
          token: support,
          body: { duration: 'monthly', reason: 'support ticket #42' },
        })
      ).json().data,
    ).toEqual({ isPremium: true });

    // Gerekçe zorunlu.
    expect(
      (await call('POST', `/admin/users/${user.id}/sessions/revoke`, { token: support, body: {} }))
        .statusCode,
    ).toBe(400);
    await call('POST', `/admin/users/${user.id}/sessions/revoke`, {
      token: support,
      body: { reason: 'lost phone' },
    });
    expect((await call('GET', '/user/me', { token: token.accessToken })).statusCode).toBe(401);

    // Silme talebi yoksa 409; varsa hemen vadesi gelir.
    const expedite = () =>
      call('POST', `/admin/users/${user.id}/deletion/expedite`, {
        token: support,
        body: { reason: 'user email request' },
      });
    expect((await expedite()).statusCode).toBe(409);
    // E-postayla gelen talep: destek oluşturur (uygulamadaki akışla aynı), sonra hızlandırır.
    const requested = await call('POST', `/admin/users/${user.id}/deletion`, {
      token: support,
      body: { reason: 'email request' },
    });
    expect(requested.statusCode).toBe(202);
    expect(new Date(requested.json().data.scheduledFor).getTime()).toBeGreaterThan(Date.now());
    expect((await expedite()).statusCode).toBe(200);
    const due = await ctx.db.one(
      'SELECT scheduled_for <= NOW(3) AS due FROM account_deletion_requests WHERE user_id = :id',
      { id: toBin(user.id) },
    );
    expect(Number(due.due)).toBe(1);

    // Kabul kriteri: yönetici işlemleri audit'e düşer.
    const actions = (
      await ctx.db.many(
        "SELECT action FROM audit_logs WHERE actor_type = 'admin' ORDER BY created_at",
      )
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'admin.login',
        'admin.login_failed',
        'admin.catalog.update',
        'admin.config.update',
        'admin.user.search',
        'admin.user.view',
        'admin.user.premium_granted',
        'admin.user.sessions_revoked',
        'admin.user.deletion_requested',
        'admin.user.deletion_expedited',
      ]),
    );
  });

  // ── Raporlar ────────────────────────────────────────────────────────
  it('raporlar: kayıt, DAU, huni, AI maliyeti', async () => {
    const guest = (await ctx.guest()).json().data;
    await call('GET', '/user/me', { token: guest.token.accessToken });
    await new Promise((r) => setTimeout(r, 100));
    await ctx.db.run(
      `INSERT INTO ai_usage_daily (user_id, usage_date, feature, requests, cost_micro_usd)
       VALUES (:id, UTC_DATE(), 'chat', 3, 125000)`,
      { id: toBin(guest.user.id) },
    );
    const analyst = await tokenFor('analyst');
    const res = await call('GET', '/admin/reports/overview?days=7', { token: analyst });
    expect(res.statusCode).toBe(200);
    const report = res.json().data;
    expect(report.range.days).toBe(7);
    expect(report.daily.signups).toHaveLength(7);
    expect(report.totals.dau).toBeGreaterThanOrEqual(1);
    expect(report.totals.aiCostUsd).toBeCloseTo(0.125, 3);
    expect(report.funnel.created).toBeGreaterThanOrEqual(1);
    const today = report.daily.signups.at(-1);
    expect(today.total).toBeGreaterThanOrEqual(1);
  });

  // ── Web hesap silme (Play Store) ────────────────────────────────────
  it('web silme bilgi sayfası (Play Store): adımlar ve destek e-postası; form yok', async () => {
    const tr = await ctx.app.inject({
      method: 'GET',
      url: '/account/delete',
      headers: { 'accept-language': 'tr-TR' },
    });
    expect(tr.statusCode).toBe(200);
    expect(tr.headers['content-type']).toMatch(/text\/html/);
    expect(tr.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(tr.body).toContain('MochiFast hesabını sil');
    expect(tr.body).toContain('Profili Düzenle');
    expect(tr.body).toMatch(/mailto:[^"]+@/);
    expect(tr.body).not.toContain('<script');
    const en = await ctx.app.inject({ method: 'GET', url: '/account/delete' });
    expect(en.body).toContain('Delete your MochiFast account');
    expect((await call('POST', '/account/delete-request', { body: {} })).statusCode).toBe(404);
  });
});
