import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { toBin } from '../../src/shared/ids.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');

/** 04 §2'deki örnek onboarding gövdesi. */
const onboardingBody = (overrides = {}) => ({
  schemaVersion: 1,
  goal: 'loseWeight',
  gender: 'woman',
  weightKg: 74,
  goalWeightKg: 64,
  heightCm: 172,
  age: 29,
  diet: 'everything',
  foodLoves: ['chicken', 'eggs', 'redMeat'],
  foodSkips: ['onions', 'tooSpicy'],
  weightHistory: 'firstTime',
  obstacles: ['lifeGotBusy', 'lostMotivation'],
  fastingReason: 'specialDate',
  planCode: '16_8',
  mealWindow: { start: '07:00', end: '19:00' },
  healthFlags: [],
  consents: { terms: '2026-10', privacy: '2026-10', healthData: true, aiProcessing: true },
  ...overrides,
});

describe.skipIf(!mysqlUrl)('kullanıcı & onboarding (gerçek MySQL)', () => {
  let ctx;
  let db;
  let call;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    ({ db, call } = ctx);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function newGuest() {
    const { token, user } = (await ctx.guest()).json().data;
    return { token: token.accessToken, userId: user.id };
  }

  const onboard = (token, overrides) =>
    call('POST', '/user/onboarding', {
      token,
      body: onboardingBody(overrides),
      headers: { 'x-timezone': 'Europe/Istanbul' },
    });

  it('GET /user/me: misafir, onboarding öncesi', async () => {
    const { token, userId } = await newGuest();
    const res = await call('GET', '/user/me', { token });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      id: userId,
      isGuest: true,
      isAnsweredQuestions: false,
      locale: 'tr',
      timezone: 'Europe/Istanbul',
      units: { weight: 'kg', height: 'cm', water: 'ml' },
      entitlements: [],
    });
  });

  it('onboarding: tek transaction; plan, projeksiyon, hedef tarih; tüm tablolar yazılır', async () => {
    const { token, userId } = await newGuest();
    const res = await onboard(token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.user.isAnsweredQuestions).toBe(true);
    expect(data.plan).toEqual({
      planCode: '16_8',
      fastMinutes: 960,
      eatWindow: { start: '11:00', end: '19:00' },
    });
    expect(data.projection).toMatchObject({ currentWeightKg: 74, goalWeightKg: 64, weeks: 25 });
    expect(data.targetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.warnings).toEqual([]);

    const profile = (await call('GET', '/user/profile', { token })).json().data;
    expect(profile).toMatchObject({
      gender: 'woman',
      age: 29,
      heightCm: 172,
      startWeightKg: 74,
      currentWeightKg: 74,
      goalWeightKg: 64,
      bmi: 25,
      goal: 'loseWeight',
      diet: 'everything',
      weightHistory: 'firstTime',
      fastingReason: 'specialDate',
      targetDate: data.targetDate,
      mealWindow: { start: '07:00', end: '19:00' },
      planCode: '16_8',
      healthFlags: [],
      foodSkips: ['onions', 'tooSpicy'],
    });
    expect(profile.foodLoves.sort()).toEqual(['chicken', 'eggs', 'redMeat']);
    expect(profile.obstacles.sort()).toEqual(['lifeGotBusy', 'lostMotivation']);

    const id = toBin(userId);
    const count = async (table, extra = '') =>
      (await db.one(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = :id ${extra}`, { id })).n;
    expect(await count('weight_entries', "AND source = 'onboarding'")).toBe(1);
    expect(await count('onboarding_submissions')).toBe(1);
    expect(await count('user_settings')).toBe(1);
    expect(await count('user_goals')).toBe(1);
    expect(await count('user_stats')).toBe(1);
    expect(await count('user_consents')).toBe(4);

    // Tekrar gönderim: profil güncellenir, onboarding kilosu tek kayıt kalır.
    expect((await onboard(token, { weightKg: 80, goalWeightKg: 70 })).statusCode).toBe(200);
    expect(await count('weight_entries', "AND source = 'onboarding'")).toBe(1);
    expect((await call('GET', '/user/profile', { token })).json().data.currentWeightKg).toBe(80);
  });

  it('kabul kriteri: 18 yaş altı + OMAD → 422 UNSAFE_REQUEST; 14:10 kabul', async () => {
    const { token, userId } = await newGuest();
    const res = await onboard(token, { age: 16, planCode: 'omad' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'UNSAFE_REQUEST',
      details: { reason: 'plan_min_age' },
    });
    // Hiçbir şey yazılmadı.
    expect(
      (
        await db.one('SELECT COUNT(*) AS n FROM user_profiles WHERE user_id = :id', {
          id: toBin(userId),
        })
      ).n,
    ).toBe(0);

    expect((await onboard(token, { age: 16, planCode: '14_10' })).statusCode).toBe(200);
    const row = await db.one('SELECT health_flags FROM user_profiles WHERE user_id = :id', {
      id: toBin(userId),
    });
    expect(row.health_flags).toBe('under_18');
    expect((await call('GET', '/user/profile', { token })).json().data.healthFlags).toEqual([]);
  });

  it('tıbbi durum + uzun oruç → SAFETY_ACK_REQUIRED; onayla kabul', async () => {
    const { token } = await newGuest();
    const res = await onboard(token, { healthFlags: ['diabetes'], planCode: '18_6' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SAFETY_ACK_REQUIRED');
    const ok = await onboard(token, {
      healthFlags: ['diabetes'],
      planCode: '18_6',
      safetyAcknowledged: true,
    });
    expect(ok.statusCode).toBe(200);
  });

  it('hedef BMI: < 18.5 uyarı, < 17.5 red; kilo verme hedefi mevcut kiloyu aşamaz', async () => {
    const { token } = await newGuest();
    const warn = await onboard(token, { goalWeightKg: 54 });
    expect(warn.json().data.warnings).toEqual(['GOAL_BMI_BELOW_18_5']);
    expect((await onboard(token, { goalWeightKg: 50 })).json().error.code).toBe('UNSAFE_REQUEST');
    const invalid = await onboard(token, { goalWeightKg: 90 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.details.fields[0].path).toBe('goalWeightKg');
    expect((await onboard(token, { goal: 'buildHabit', goalWeightKg: 76 })).statusCode).toBe(200);
  });

  it('sağlık verisi rızası yoksa 403 CONSENT_REQUIRED; şema ihlali 400', async () => {
    const { token } = await newGuest();
    const res = await onboard(token, {
      consents: { terms: '2026-10', privacy: '2026-10', healthData: false },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CONSENT_REQUIRED');

    const bad = await onboard(token, { foodLoves: [], age: 12, planCode: '24_0' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_FAILED');
    expect((await call('POST', '/user/onboarding', { body: onboardingBody() })).statusCode).toBe(
      401,
    );
  });

  it('kabul kriteri: misafir → onboarding → Apple girişi → aynı userId, veriler korunur', async () => {
    const { token, userId } = await newGuest();
    expect((await onboard(token)).statusCode).toBe(200);
    const login = await ctx.appleLogin({ sub: `apple-${randomUUID()}`, token });
    expect(login.json().data).toMatchObject({ linkedFromGuest: true, user: { id: userId } });
    const access = login.json().data.token.accessToken;
    const me = (await call('GET', '/user/me', { token: access })).json().data;
    expect(me).toMatchObject({ id: userId, isGuest: false, isAnsweredQuestions: true });
    expect((await call('GET', '/user/profile', { token: access })).json().data.planCode).toBe(
      '16_8',
    );
  });

  it('PATCH /user/me: ad, dil, saat dilimi, birimler', async () => {
    const { token } = await newGuest();
    const res = await call('PATCH', '/user/me', {
      token,
      body: { name: '  Ayşe ', locale: 'de', timezone: 'Europe/Berlin', units: { height: 'ftIn' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      name: 'Ayşe',
      locale: 'de',
      timezone: 'Europe/Berlin',
      units: { weight: 'kg', height: 'ftIn', water: 'ml' },
    });
    const badTz = await call('PATCH', '/user/me', { token, body: { timezone: 'Mars/Base' } });
    expect(badTz.statusCode).toBe(400);
    expect((await call('PATCH', '/user/me', { token, body: {} })).statusCode).toBe(400);
  });

  it('PATCH /user/profile: kilo yeni kayıt olur; sağlık kuralı birleşik durumda uygulanır', async () => {
    const { token, userId } = await newGuest();
    await onboard(token);
    const res = await call('PATCH', '/user/profile', {
      token,
      body: { weightKg: 72.5, diet: 'lowCarb', foodLoves: ['fish'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      startWeightKg: 74,
      currentWeightKg: 72.5,
      diet: 'lowCarb',
      foodLoves: ['fish'],
      warnings: [],
    });
    expect(
      (
        await db.one(
          "SELECT COUNT(*) AS n FROM weight_entries WHERE user_id = :id AND source = 'manual'",
          {
            id: toBin(userId),
          },
        )
      ).n,
    ).toBe(1);

    // Mevcut plan 16:8 iken hamilelik bildirilirse reddedilir; plan da değiştirilirse kabul.
    const unsafe = await call('PATCH', '/user/profile', {
      token,
      body: { healthFlags: ['pregnant'] },
    });
    expect(unsafe.statusCode).toBe(422);
    const safe = await call('PATCH', '/user/profile', {
      token,
      body: { healthFlags: ['pregnant'], planCode: '12_12' },
    });
    expect(safe.statusCode).toBe(200);
    expect(safe.json().data).toMatchObject({ healthFlags: ['pregnant'], planCode: '12_12' });
  });

  it('ayarlar: varsayılanlar ve kısmi güncelleme', async () => {
    const { token } = await newGuest();
    const defaults = (await call('GET', '/user/settings', { token })).json().data;
    expect(defaults).toEqual({
      pushEnabled: true,
      notifications: {
        fasting: true,
        streak: true,
        weight: true,
        water: false,
        challenges: true,
        marketing: false,
      },
      waterReminderIntervalMin: 120,
      quietHours: { start: '22:30', end: '08:00' },
      healthSyncEnabled: false,
    });
    const res = await call('PATCH', '/user/settings', {
      token,
      body: { notifications: { water: true }, quietHours: { start: '23:00', end: '07:30' } },
    });
    expect(res.json().data).toMatchObject({
      notifications: { water: true, fasting: true },
      quietHours: { start: '23:00', end: '07:30' },
    });
  });

  it('hedefler: sunucu önerisi (computed) ve kullanıcı değerleri', async () => {
    const { token } = await newGuest();
    const empty = (await call('GET', '/user/goals', { token })).json().data;
    expect(empty).toMatchObject({
      waterGoalMl: 2500,
      kcalGoal: null,
      computed: { kcalGoal: null },
    });

    await onboard(token);
    const goals = (await call('GET', '/user/goals', { token })).json().data;
    expect(goals.computed).toEqual({
      kcalGoal: 1370,
      proteinGoalG: 89,
      carbsGoalG: 152,
      fatGoalG: 45,
    });

    const res = await call('PATCH', '/user/goals', {
      token,
      body: { kcalGoal: 1600, customGlassSizes: [350, 750, 350], bedtime: '23:30' },
    });
    expect(res.json().data).toMatchObject({
      kcalGoal: 1600,
      customGlassSizes: [350, 750],
      bedtime: '23:30',
      computed: { kcalGoal: 1370 },
    });
  });

  it('rızalar: yalnızca ekleme, her tür için son durum', async () => {
    const { token } = await newGuest();
    await onboard(token);
    await call('POST', '/user/consents', {
      token,
      body: { type: 'marketingPush', version: '2026-10', granted: true },
    });
    const res = await call('POST', '/user/consents', {
      token,
      body: { type: 'aiProcessing', version: '2026-11', granted: false },
    });
    const items = Object.fromEntries(res.json().data.items.map((i) => [i.type, i]));
    expect(items.aiProcessing).toMatchObject({ version: '2026-11', granted: false });
    expect(items.marketingPush.granted).toBe(true);
    expect(items.healthData.granted).toBe(true);
  });

  it('cihaz: kayıt + push token; aynı token başka hesaba geçince eskiden silinir', async () => {
    const installId = randomUUID();
    const a = await newGuest();
    const put = (token, body) =>
      call('PUT', '/devices/current', {
        token,
        body: { installId, platform: 'android', appVersion: '1.2.0', ...body },
      });
    const res = await put(a.token, { pushToken: 'fcm-1', deviceModel: 'Pixel 9' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ installId, platform: 'android', hasPushToken: true });

    const b = await newGuest();
    await put(b.token, { pushToken: 'fcm-1' });
    const owners = await db.many("SELECT user_id FROM devices WHERE push_token = 'fcm-1'");
    expect(owners).toHaveLength(1);
    expect(owners[0].user_id.equals(toBin(b.userId))).toBe(true);

    const del = await call('DELETE', '/devices/current/push-token', { token: b.token });
    expect(del.statusCode).toBe(200);
    expect(await db.many("SELECT id FROM devices WHERE push_token = 'fcm-1'")).toEqual([]);
  });

  it('ilerleme iskeleti ve eski istemci yolları (Deprecation header)', async () => {
    const { token } = await newGuest();
    await onboard(token);
    expect((await call('GET', '/user/progress', { token })).json().data).toEqual({
      level: 1,
      streakDays: 0,
      completedFasts: 0,
      xp: 0,
    });

    const legacyMe = await call('GET', '/user/me', { token, prefix: '' });
    expect(legacyMe.statusCode).toBe(200);
    expect(legacyMe.headers.deprecation).toBe('true');
    expect(legacyMe.headers.link).toContain('/v1/user/me');
    expect(legacyMe.json().data.isAnsweredQuestions).toBe(true);

    const legacyOnboarding = await call('PATCH', '/user/onboarding', {
      prefix: '',
      body: { level: 3 },
    });
    expect(legacyOnboarding.statusCode).toBe(200);
    expect(legacyOnboarding.headers.deprecation).toBe('true');

    const legacyRegister = await call('POST', '/auth/register', {
      prefix: '',
      body: { provider: 'guest', deviceId: randomUUID(), platform: 'ios' },
    });
    expect(legacyRegister.statusCode).toBe(201);
    expect(legacyRegister.headers.deprecation).toBe('true');
    expect(legacyRegister.json().data.user.isGuest).toBe(true);

    // Yalnızca listelenen eski yollar açık; diğerleri öneksiz çalışmaz.
    const noLegacyGuest = await call('POST', '/auth/guest', {
      prefix: '',
      body: { installId: randomUUID(), platform: 'ios' },
    });
    expect(noLegacyGuest.statusCode).toBe(404);
  });
});
