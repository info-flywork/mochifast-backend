import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { statsJobs } from '../../src/jobs/stats.jobs.js';
import { createStatsService } from '../../src/modules/stats/stats.service.js';
import { toBin } from '../../src/shared/ids.js';
import { addDays } from '../../src/shared/time.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const TZ = 'Europe/Istanbul';
const H = 3_600_000;
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
const today = () => DateTime.now().setZone(TZ).toISODate();
/** `daysAgo` gün önce yerel 06:00'da biten 16 saatlik oruç. */
function pastFast(daysAgo) {
  const end = DateTime.fromISO(`${addDays(today(), -daysAgo)}T06:00`, { zone: TZ });
  return { startedAt: end.minus({ hours: 16 }).toISO(), endedAt: end.toISO() };
}

describe.skipIf(!mysqlUrl)("Mochi World ve challenge'lar (gerçek MySQL)", () => {
  let ctx;
  let call;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    ({ call } = ctx);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function newUser({ onboard = true } = {}) {
    const { token, user } = (await ctx.guest(randomUUID(), { timezone: TZ })).json().data;
    if (onboard) {
      const res = await call('POST', '/user/onboarding', {
        token: token.accessToken,
        body: onboardingBody,
        headers: { 'x-timezone': TZ },
      });
      expect(res.statusCode).toBe(200);
    }
    return { token: token.accessToken, userId: user.id };
  }
  const get = async (token, url, headers) =>
    (await call('GET', url, { token, headers })).json().data;
  const zone = (world, name) => world.zones.find((z) => z.zone === name);

  it('bölgeler gerçek veriden; bitirme yanıtı orman seviye atlamasını bildirir', async () => {
    const { token } = await newUser();
    for (const d of [2, 1]) await call('POST', '/fasts/manual', { token, body: pastFast(d) });
    const fast = (
      await call('POST', '/fasts', {
        token,
        body: { startedAt: new Date(Date.now() - 17 * H).toISOString() },
      })
    ).json().data.fast;
    const finish = (await call('POST', `/fasts/${fast.id}/finish`, { token, body: {} })).json()
      .data;
    expect(finish.world).toEqual({
      health: 'thriving',
      levelUps: [{ zone: 'forest', from: 0, to: 1 }],
    });

    for (let i = 0; i < 3; i += 1) await call('POST', '/meals', { token, body: { kcal: 300 } });
    await call('POST', '/water', { token, body: { amountMl: 2600 } });

    const world = await get(token, '/world');
    expect(world).toMatchObject({
      level: 1,
      sceneLevel: 0,
      nextSceneLevelAt: 2,
      health: 'thriving',
    });
    expect(zone(world, 'forest')).toMatchObject({
      current: 3,
      level: 1,
      nextThreshold: 10,
      unit: 'fasts',
    });
    expect(zone(world, 'garden')).toMatchObject({ current: 3, level: 1, nextThreshold: 10 });
    expect(zone(world, 'lake')).toMatchObject({ current: 1, level: 0, nextThreshold: 3 });
    expect(zone(world, 'summit')).toMatchObject({ current: 0, level: 0, nextThreshold: 1 });
    expect(world.zones[0].thresholds).toEqual([3, 10, 25, 50]);
    expect(world.worldProgress).toBeGreaterThan(0);
    expect(world.week).toHaveLength(7);
  });

  it('zirve: en iyi verilen kilo; ölçüm silinse de ada geri gitmez', async () => {
    const { token } = await newUser();
    const low = (await call('POST', '/weights', { token, body: { weightKg: 72.8 } })).json().data
      .entry;
    await call('POST', '/weights', { token, body: { weightKg: 75 } });
    expect(zone(await get(token, '/world'), 'summit')).toMatchObject({ current: 1.2, level: 1 });

    await call('DELETE', `/weights/${low.id}`, { token });
    expect(zone(await get(token, '/world'), 'summit')).toMatchObject({
      current: 0,
      level: 1,
      nextThreshold: 2,
    });
  });

  it('kabul kriteri: 4 zorunlu gün kaçınca drought, tek tutulmuş gün thriving', async () => {
    const { token } = await newUser();
    await call('POST', '/fasts/manual', { token, body: pastFast(6) });
    expect((await get(token, '/world')).health).toBe('drought');

    // Bugün biten tam bir oruç (dünkü 18:00 → bugün 10:00 yerel ya da şimdiye kadar).
    const end = DateTime.now().setZone(TZ).minus({ minutes: 5 });
    await call('POST', '/fasts/manual', {
      token,
      body: { startedAt: end.minus({ hours: 16 }).toISO(), endedAt: end.toISO() },
    });
    expect((await get(token, '/world')).health).toBe('thriving');
  });

  it('kabul kriteri: "1 haftalık oruç" challenge\'ı (7 günde 3 öğün) tamamlanır ve XP verir', async () => {
    const { token, userId } = await newUser();
    const list = await get(token, '/challenges', { 'accept-language': 'tr' });
    expect(list.items.map((c) => c.code)).toEqual([
      'week_meals_3',
      'week_fasts_3',
      'water_week_5',
      'hunger_aware_5',
    ]);
    expect(list.items[0]).toMatchObject({
      title: '1 haftalık oruç meydan okuması',
      badge: '7G / 3x',
      targetCount: 3,
      durationDays: 7,
      metric: 'mealsLogged',
      my: null,
    });
    const featured = (await get(token, '/challenges/featured')).challenge;
    expect(featured.code).toBe('week_meals_3');
    const before = featured.participantsCount;

    const joined = (await call('POST', '/challenges/week_meals_3/join', { token })).json().data
      .challenge;
    expect(joined).toMatchObject({
      participantsCount: before + 1,
      my: { status: 'active', progress: 0, target: 3 },
    });
    expect((await call('POST', '/challenges/week_meals_3/join', { token })).statusCode).toBe(409);

    const xpBefore = (await get(token, '/user/progress')).xp;
    for (let i = 0; i < 3; i += 1) await call('POST', '/meals', { token, body: { kcal: 200 } });
    const done = (await get(token, '/challenges')).items.find((c) => c.code === 'week_meals_3');
    expect(done.my).toMatchObject({ status: 'completed', progress: 3 });
    expect(done.my.completedAt).toBeTruthy();
    // 3 öğün × 2 + challenge ödülü 50
    expect((await get(token, '/user/progress')).xp - xpBefore).toBe(56);
    const xp = await ctx.db.one(
      "SELECT amount FROM xp_events WHERE user_id = :id AND reason = 'challenge_completed'",
      { id: toBin(userId) },
    );
    expect(xp.amount).toBe(50);

    // Tamamlandıktan sonra yeniden katılım açılır (yeni pencere).
    expect((await call('POST', '/challenges/week_meals_3/join', { token })).statusCode).toBe(200);
    expect((await get(token, '/user/summary')).featuredChallenge.my.status).toBe('active');
  });

  it('ayrılma, süre dolumu ve gerçek katılımcı sayısı', async () => {
    const a = await newUser();
    const b = await newUser();
    const count = async () =>
      (await get(a.token, '/challenges')).items.find((c) => c.code === 'water_week_5')
        .participantsCount;
    const start = await count();
    await call('POST', '/challenges/water_week_5/join', { token: a.token });
    await call('POST', '/challenges/water_week_5/join', { token: b.token });
    expect(await count()).toBe(start + 2);

    const left = await call('POST', '/challenges/water_week_5/leave', { token: b.token });
    expect(left.json().data.challenge.my.status).toBe('left');
    expect(await count()).toBe(start + 1);
    expect(
      (await call('POST', '/challenges/water_week_5/leave', { token: b.token })).statusCode,
    ).toBe(404);

    await ctx.db.run(
      'UPDATE challenge_participants SET window_end = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE user_id = :id',
      { id: toBin(a.userId) },
    );
    await statsJobs({
      db: ctx.db,
      stats: createStatsService({ db: ctx.db }),
      logger: silent,
    }).challengeExpire();
    const mine = (await get(a.token, '/challenges')).items.find(
      (c) => c.code === 'water_week_5',
    ).my;
    expect(mine.status).toBe('failed');
    expect((await call('POST', '/challenges/nope/join', { token: a.token })).statusCode).toBe(404);
  });

  it('katılımcı listesi: rıza yoksa anonim, kişi kendini görür, kimlik dönmez', async () => {
    const a = await newUser();
    const b = await newUser();
    await ctx.db.run("UPDATE users SET display_name = 'Ayşe Yılmaz' WHERE id = :id", {
      id: toBin(a.userId),
    });
    await ctx.db.run("UPDATE users SET display_name = 'Mehmet Kaya' WHERE id = :id", {
      id: toBin(b.userId),
    });
    await call('POST', '/challenges/water_week_5/join', { token: a.token });
    await call('POST', '/challenges/water_week_5/join', { token: b.token });

    const list = async (token) => get(token, '/challenges/water_week_5/participants');
    const row = (data, pred) => data.items.find(pred);

    // Varsayılan: rıza kapalı → b, a'yı anonim görür; a kendini adıyla görür.
    let seenByB = await list(b.token);
    expect(seenByB.total).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(seenByB)).not.toContain('Ayşe');
    expect(JSON.stringify(seenByB)).not.toContain(a.userId);
    expect(row(seenByB, (r) => r.isMe).displayName).toBe('Mehmet K.');
    expect(row(await list(a.token), (r) => r.isMe).displayName).toBe('Ayşe Y.');

    // a rıza verir → b onu kısaltılmış adıyla görür.
    const patched = await call('PATCH', '/user/settings', {
      token: a.token,
      body: { showInChallenges: true },
    });
    expect(patched.json().data.showInChallenges).toBe(true);
    seenByB = await list(b.token);
    expect(row(seenByB, (r) => r.displayName === 'Ayşe Y.')).toMatchObject({ isMe: false });

    const detail = await get(b.token, '/challenges/water_week_5');
    expect(detail.challenge.code).toBe('water_week_5');
    expect(
      (await call('GET', '/challenges/nope/participants', { token: a.token })).statusCode,
    ).toBe(404);
  });
});
