import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId, toBin } from '../../src/shared/ids.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const TZ = 'Europe/Istanbul';
const H = 3_600_000;

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
const today = () => DateTime.now().setZone(TZ).toISODate();

describe.skipIf(!mysqlUrl)('öğün, beslenme ve açlık (gerçek MySQL)', () => {
  let ctx;
  let call;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    ({ call } = ctx);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function newUser() {
    const { token, user } = (await ctx.guest(randomUUID(), { timezone: TZ })).json().data;
    const res = await call('POST', '/user/onboarding', {
      token: token.accessToken,
      body: onboardingBody,
      headers: { 'x-timezone': TZ },
    });
    expect(res.statusCode).toBe(200);
    return { token: token.accessToken, userId: user.id };
  }
  const get = async (token, url, headers) =>
    (await call('GET', url, { token, headers })).json().data;
  const stats = (userId) =>
    ctx.db.one('SELECT xp, meals_logged FROM user_stats WHERE user_id = :id', {
      id: toBin(userId),
    });

  // ── Öğün ve beslenme ────────────────────────────────────────────────
  it('öğün → günlük kalori, makrolar, hedef; düzenleme ve silme', async () => {
    const { token } = await newUser();
    const id = newId();
    const body = {
      id,
      kind: 'meal',
      slot: 'lunch',
      dietType: 'lowCarb',
      feeling: 'super',
      title: 'Izgara tavuk',
      notes: 'Doydum',
      kcal: 550,
      proteinG: 42.5,
      carbsG: 20,
      fatG: 18,
    };
    const created = await call('POST', '/meals', { token, body });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      meal: { id, dietType: 'lowCarb', notes: 'Doydum', source: 'manual', localDate: today() },
      suggestEndFast: false,
      activeFastId: null,
    });
    expect((await call('POST', '/meals', { token, body })).statusCode).toBe(200);

    const day = await get(token, '/nutrition/day');
    expect(day).toMatchObject({
      kcal: 550,
      macros: { protein: { g: 42.5 }, carbs: { g: 20 }, fat: { g: 18 } },
      overKcal: 0,
    });
    expect(day.kcalGoal).toBeGreaterThan(1200);
    expect(day.macros.protein.goalG).toBeGreaterThan(0);
    expect(day.burnedKcal).toBeGreaterThanOrEqual(0);
    expect(day.meals).toHaveLength(1);

    await call('PATCH', `/meals/${id}`, { token, body: { kcal: 700, notes: null } });
    expect((await get(token, `/meals/${id}`)).meal).toMatchObject({ kcal: 700, notes: null });
    const summary = await get(token, '/user/summary');
    expect(summary.today.nutrition.kcal).toBe(700);
    expect(summary.today.lastMeal).toMatchObject({ id, title: 'Izgara tavuk', kcal: 700 });

    const week = await get(token, '/nutrition/week?metric=protein');
    expect(week.days.find((d) => d.isToday)).toMatchObject({ value: 42.5 });

    expect((await call('DELETE', `/meals/${id}`, { token })).statusCode).toBe(200);
    expect((await get(token, '/nutrition/day')).kcal).toBe(0);
    expect((await call('GET', `/meals/${id}`, { token })).statusCode).toBe(404);
  });

  it('aktif oruçta öğün → "orucu bitir?" önerisi', async () => {
    const { token } = await newUser();
    const fast = (
      await call('POST', '/fasts', {
        token,
        body: { startedAt: new Date(Date.now() - 10 * H).toISOString() },
      })
    ).json().data.fast;
    const res = (await call('POST', '/meals', { token, body: { kcal: 200, kind: 'snack' } })).json()
      .data;
    expect(res).toMatchObject({ suggestEndFast: true, activeFastId: fast.id });
    // Orucun başlangıcından önceki öğün orucu bozmaz.
    const before = (
      await call('POST', '/meals', {
        token,
        body: { kcal: 300, eatenAt: new Date(Date.now() - 11 * H).toISOString() },
      })
    ).json().data;
    expect(before.suggestEndFast).toBe(false);
  });

  it('öğün XP günde en fazla 5 öğün; sayaç ve geçmiş sayfalaması', async () => {
    const { token, userId } = await newUser();
    for (let i = 0; i < 6; i += 1) {
      await call('POST', '/meals', {
        token,
        body: { kcal: 100, eatenAt: new Date(Date.now() - (6 - i) * 60_000).toISOString() },
      });
    }
    expect(await stats(userId)).toMatchObject({ xp: 10, meals_logged: 6 });
    const page = await get(token, '/meals?limit=4');
    expect(page.items).toHaveLength(4);
    const rest = await get(token, `/meals?limit=4&cursor=${page.pageInfo.nextCursor}`);
    expect(rest.items).toHaveLength(2);
    expect((await get(token, `/meals?date=${today()}`)).items).toHaveLength(6);
  });

  it('kabul kriteri: yeme bozukluğu bayrağında kcalGoal = null', async () => {
    const { token } = await newUser();
    await call('PATCH', '/user/goals', { token, body: { kcalGoal: 1800 } });
    const res = await call('PATCH', '/user/profile', {
      token,
      body: { healthFlags: ['eatingDisorderHistory'] },
    });
    expect(res.statusCode).toBe(200);
    await call('POST', '/meals', { token, body: { kcal: 900 } });
    const day = await get(token, '/nutrition/day');
    expect(day).toMatchObject({ kcal: 900, kcalGoal: null, overKcal: null, progress: null });
    expect(day.macros.protein.goalG).toBeNull();
    expect((await get(token, '/user/summary')).today.nutrition.kcalGoal).toBeNull();
  });

  // ── Açlık ───────────────────────────────────────────────────────────
  it('kabul kriteri: sonuç sunucuda hesaplanır; istemcinin sonucu dikkate alınmaz', async () => {
    const { token, userId } = await newUser();
    const answers = {
      q1: 'yes',
      q2: 'gradually',
      bodyNotices: ['stomachGrowling'],
      q4: 'almostAnything',
    };
    const evaluated = await call('POST', '/hunger-checkins/evaluate', {
      token,
      body: answers,
      headers: { 'accept-language': 'tr' },
    });
    expect(evaluated.json().data).toMatchObject({
      resultType: 'physical',
      physicalScore: 7,
      safetyFlag: false,
      recommendations: [{ code: 'physical_1' }, { code: 'physical_2' }, { code: 'physical_3' }],
    });
    expect(evaluated.json().data.recommendations[0].title).not.toBe('physical_1');

    const saved = await call('POST', '/hunger-checkins', {
      token,
      body: {
        ...answers,
        mode: 'full',
        resultType: 'emotional',
        emotionalScore: 9,
        notes: 'öğlen',
      },
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().data).toMatchObject({
      resultType: 'physical',
      checkin: { resultType: 'physical', emotionalScore: 0, notes: 'öğlen', mode: 'full' },
    });

    await call('POST', '/hunger-checkins', {
      token,
      body: { mode: 'quick', q1: 'notReally', q4: 'somethingSweet' },
    });
    for (let i = 0; i < 2; i += 1) {
      await call('POST', '/hunger-checkins', { token, body: { mode: 'hungryNow', q1: 'yes' } });
    }
    // 4 check-in, XP en fazla 3 × 2.
    expect((await stats(userId)).xp).toBe(6);
    const summary = await get(token, '/hunger-checkins/summary');
    expect(summary.today).toMatchObject({ total: 4, physical: 3, emotional: 1 });
    expect(summary.week).toHaveLength(7);
    expect((await get(token, '/user/summary')).today.hunger).toEqual({ physical: 3, emotional: 1 });

    const emotional = await get(token, '/hunger-checkins?type=emotional');
    expect(emotional.items).toHaveLength(1);
    expect(emotional.items[0]).toMatchObject({ q1: 'notReally', q4: 'somethingSweet' });

    await call('DELETE', `/hunger-checkins/${emotional.items[0].id}`, { token });
    expect((await get(token, '/hunger-checkins/summary')).today.emotional).toBe(0);
  });

  it('güvenlik: uzun oruçta baş dönmesi → orucu bitirme önerisi önce', async () => {
    const { token } = await newUser();
    const fast = (
      await call('POST', '/fasts', {
        token,
        body: { startedAt: new Date(Date.now() - 17 * H).toISOString() },
      })
    ).json().data.fast;
    const res = (
      await call('POST', '/hunger-checkins', {
        token,
        body: { mode: 'full', symptoms: ['dizziness'], bodyNotices: ['lowEnergy'] },
        headers: { 'accept-language': 'tr' },
      })
    ).json().data;
    expect(res).toMatchObject({ safetyFlag: true, activeFastId: fast.id });
    expect(res.recommendations[0]).toEqual({
      code: 'safety_end_fast',
      title: 'Kendini iyi hissetmiyorsan orucunu şimdi bitirmen tamamen normal.',
    });
    // Planın %75'i geçildi ve fiziksel belirti var: bağlam +1.
    expect(res.physicalScore).toBe(2);
    expect(res.checkin).toMatchObject({ fastId: fast.id });
    expect(res.checkin.fastedMinutes).toBeGreaterThanOrEqual(1019);
  });
});
