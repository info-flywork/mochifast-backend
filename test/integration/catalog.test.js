import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { loadCatalogSeeds, seedCatalog } from '../../src/modules/catalog/catalog.seeder.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');

describe.skipIf(!mysqlUrl)('katalog & uygulama yapılandırması (gerçek MySQL)', () => {
  let ctx;
  let call;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    ({ call } = ctx);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const plans = (lang = 'en', extra = {}) =>
    call('GET', '/catalog/plans', { headers: { 'accept-language': lang, ...extra } });
  const allPlans = (body) => body.data.groups.flatMap((g) => g.plans);

  it('21 plan, ürün dokümanındaki gruplar ve sıra; 18:6 hem Popular hem Intermediate', async () => {
    const res = await plans();
    expect(res.statusCode).toBe(200);
    const { groups, timings } = res.json().data;
    expect(groups.map((g) => g.category)).toEqual([
      'beginner',
      'popular',
      'intermediate',
      'advanced',
      'weekly',
      'flexible',
    ]);
    const byGroup = Object.fromEntries(groups.map((g) => [g.category, g.plans.map((p) => p.code)]));
    expect(byGroup.beginner).toEqual(['12_12', '13_11', '14_10', '15_9']);
    expect(byGroup.popular).toEqual(['16_8', '18_6']);
    expect(byGroup.intermediate).toEqual(['17_7', '18_6', '19_5']);
    expect(byGroup.advanced).toEqual(['20_4', '21_3', '22_2', '23_1', 'omad']);
    expect(byGroup.weekly).toEqual(['5_2', '6_1', 'alternate_day', 'crescendo']);
    expect(byGroup.flexible).toEqual(['early_tre', 'late_tre', 'custom_daily', 'custom_weekly']);
    expect(new Set(allPlans(res.json()).map((p) => p.code)).size).toBe(21);
    expect(timings.map((t) => t.code)).toEqual([
      'skipBreakfast',
      'skipDinner',
      'earlyWindow',
      'lateWindow',
      'custom',
    ]);

    const p168 = allPlans(res.json()).find((p) => p.code === '16_8');
    expect(p168).toMatchObject({
      displayName: '16:8',
      cardLabel: 'Most Popular',
      isFeatured: true,
      isPremium: false,
      isLocked: false,
      fastHours: 16,
      eatHours: 8,
      defaultTiming: 'skipBreakfast',
      defaultEatStart: '12:00',
    });
  });

  it('oturumsuz istekte premium planlar kilitli; ücretsizler açık', async () => {
    const list = allPlans((await plans()).json());
    const locked = list.filter((p) => p.isLocked).map((p) => p.code);
    expect(locked).toContain('omad');
    expect(locked).not.toContain('16_8');
    expect(list.every((p) => p.isLocked === p.isPremium)).toBe(true);
  });

  it('Accept-Language: tr Türkçe; desteklenmeyen dil İngilizceye düşer', async () => {
    const tr = (await plans('tr-TR,tr;q=0.9')).json().data;
    expect(tr.groups[0].title).toBe('Başlangıç Seviyesi');
    expect(allPlans({ data: tr }).find((p) => p.code === '16_8').cardLabel).toBe('En Popüler');
    expect(tr.timings[0].title).toBe('Kahvaltıyı atla');
    const ja = (await plans('ja')).json().data;
    expect(ja.groups[0].title).toBe('Beginner Level');
  });

  it('HTTP cache: public + Vary; aynı ETag ile 304; token varsa private', async () => {
    const first = await plans('de');
    expect(first.headers['cache-control']).toBe(
      'public, max-age=300, stale-while-revalidate=86400',
    );
    expect(first.headers.vary).toBe('Accept-Language');
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    const again = await plans('de', { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    // Farklı dilin içeriği farklı → farklı ETag.
    expect((await plans('fr')).headers.etag).not.toBe(etag);

    const { token } = (await ctx.guest()).json().data;
    const personal = await call('GET', '/catalog/plans', { token: token.accessToken });
    expect(personal.headers['cache-control']).toBe('private, max-age=60');
    expect(personal.headers.vary).toContain('Authorization');
    // Geçersiz token katalogda hata değil: oturumsuz görünüm.
    const bad = await call('GET', '/catalog/plans', { token: 'local-onboarding-session' });
    expect(bad.statusCode).toBe(200);
  });

  it('plan detayı: güvenlik notu, örnek pencere, haftalık şablon; bilinmeyen kod 404', async () => {
    const omad = (
      await call('GET', '/catalog/plans/omad', { headers: { 'accept-language': 'tr' } })
    ).json().data;
    expect(omad).toMatchObject({ displayName: 'OMAD', requiresSafetyAck: true });
    expect(omad.safetyNote).toMatch(/doktoruna danış/);
    expect(omad.exampleWindow).toEqual({ start: '18:00', end: '19:00' });

    const p168 = (await call('GET', '/catalog/plans/16_8')).json().data;
    expect(p168.exampleWindow).toEqual({ start: '12:00', end: '20:00' });
    expect(p168.weeklyTemplate).toBeNull();

    const p52 = (await call('GET', '/catalog/plans/5_2')).json().data;
    const reduced = p52.weeklyTemplate.filter((d) => d.type === 'reduced').map((d) => d.dow);
    expect(reduced).toEqual([1, 4]);
    expect(p52.weeklyTemplate.find((d) => d.dow === 1).kcal).toBe(500);

    expect((await call('GET', '/catalog/plans/24_0')).statusCode).toBe(404);
  });

  it('kabul kriteri: önbellekli katalog p95 < 30 ms', async () => {
    await plans('it');
    const times = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      await plans('it');
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(30);
  });

  it('app config: platforma göre sürümler, özellikler, limitler, yasal sürümler', async () => {
    const res = await call('GET', '/app/config', {
      headers: { 'x-platform': 'ios', 'x-app-version': '1.0.0' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      platform: 'ios',
      minAppVersion: '1.0.0',
      latestAppVersion: '1.0.0',
      updateRequired: false,
      updateAvailable: false,
      features: { chat: true, photoAnalysis: true },
      limits: { freeChatDaily: 3, freePhotoDaily: 2 },
      marketing: { activeUsers: '2M+', rating: 4.8 },
      legal: { termsVersion: '2026-10', privacyVersion: '2026-10' },
    });
    expect(res.headers.vary).toContain('X-Platform');
  });

  it('min sürüm: altındaki istemci 426; sağlık ve config muaf; diğer platform etkilenmez', async () => {
    await ctx.db.run(
      `UPDATE app_config SET value = '"2.0.0"'
        WHERE config_key = 'app.min_version' AND platform = 'ios'`,
    );
    await ctx.app.deps.cache.del('cfg:app:rows');
    const old = { 'x-platform': 'ios', 'x-app-version': '1.9.9' };

    const blocked = await call('GET', '/catalog/plans', { headers: old });
    expect(blocked.statusCode).toBe(426);
    expect(blocked.json().error).toMatchObject({
      code: 'APP_UPDATE_REQUIRED',
      details: { minAppVersion: '2.0.0', platform: 'ios' },
    });
    expect((await ctx.app.inject({ url: '/health/live', headers: old })).statusCode).toBe(200);
    const cfg = await call('GET', '/app/config', { headers: old });
    expect(cfg.json().data.updateRequired).toBe(true);
    const android = { 'x-platform': 'android', 'x-app-version': '1.9.9' };
    expect((await call('GET', '/catalog/plans', { headers: android })).statusCode).toBe(200);
    const current = { 'x-platform': 'ios', 'x-app-version': '2.0.0' };
    expect((await call('GET', '/catalog/plans', { headers: current })).statusCode).toBe(200);

    await ctx.db.run(
      `UPDATE app_config SET value = '"1.0.0"'
        WHERE config_key = 'app.min_version' AND platform = 'ios'`,
    );
    await ctx.app.deps.cache.del('cfg:app:rows');
  });

  it('seed idempotent: tekrar çalışınca aynı katalog, sürüm artar, yönetim değerleri korunur', async () => {
    await ctx.db.run(
      `UPDATE app_config SET value = '{"activeUsers":"3M+","rating":4.9,"avgStreakDays":14,"trustedBy":"300K+"}'
        WHERE config_key = 'marketing'`,
    );
    const before = await ctx.db.one(
      "SELECT CAST(value AS CHAR) AS value FROM app_config WHERE config_key = 'catalog.version'",
    );
    const stats = await seedCatalog(ctx.db, await loadCatalogSeeds());
    expect(stats).toMatchObject({ plans: 21, deactivated: 0, configAdded: 0 });
    expect(stats.catalogVersion).toBe(Number(JSON.parse(before.value)) + 1);
    expect((await ctx.db.one('SELECT COUNT(*) AS n FROM fasting_plan_translations')).n).toBe(
      21 * 7,
    );
    const marketing = await ctx.db.one(
      "SELECT CAST(value AS CHAR) AS value FROM app_config WHERE config_key = 'marketing'",
    );
    expect(JSON.parse(marketing.value).activeUsers).toBe('3M+');
  });

  it('onboarding planı katalogdan doğrular: bilinmeyen kod 400, özel plan kabul', async () => {
    const { token } = (await ctx.guest()).json().data;
    const body = (planCode) => ({
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
      planCode,
      mealWindow: { start: '07:00', end: '15:00' },
      consents: { terms: '2026-10', privacy: '2026-10', healthData: true },
    });
    const unknown = await call('POST', '/user/onboarding', {
      token: token.accessToken,
      body: body('99_1'),
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.details.fields[0].path).toBe('planCode');

    const early = await call('POST', '/user/onboarding', {
      token: token.accessToken,
      body: body('early_tre'),
    });
    expect(early.statusCode).toBe(200);
    expect(early.json().data.plan).toEqual({
      planCode: 'early_tre',
      fastMinutes: 960,
      eatWindow: { start: '07:00', end: '15:00' },
    });
  });
});
