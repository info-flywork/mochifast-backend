import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId, toBin } from '../../src/shared/ids.js';
import { addDays } from '../../src/shared/time.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const TZ = 'Europe/Istanbul';

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
/** Yerel gün + saat → ISO an. */
const at = (date, hhmm) => DateTime.fromISO(`${date}T${hhmm}`, { zone: TZ }).toUTC().toISO();

describe.skipIf(!mysqlUrl)('takipçiler: kilo, su, adım, uyku (gerçek MySQL)', () => {
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
    ctx.db.one('SELECT xp, water_goal_days FROM user_stats WHERE user_id = :id', {
      id: toBin(userId),
    });

  // ── Su ──────────────────────────────────────────────────────────────
  it('kabul kriteri: 23:50 o güne, 00:10 ertesi güne yazılır', async () => {
    const { token } = await newUser();
    const d = addDays(today(), -1);
    const late = await call('POST', '/water', {
      token,
      body: { amountMl: 300, loggedAt: at(addDays(d, -1), '23:50') },
    });
    expect(late.statusCode).toBe(201);
    expect(late.json().data).toMatchObject({ date: addDays(d, -1), totalMl: 300 });
    const early = await call('POST', '/water', {
      token,
      body: { amountMl: 250, loggedAt: at(d, '00:10') },
    });
    expect(early.json().data).toMatchObject({ date: d, totalMl: 250 });
    expect((await get(token, `/water/day?date=${addDays(d, -1)}`)).totalMl).toBe(300);
  });

  it('hedef günü XP ve sayaç; geri alınca düşer; tekrar gönderim yinelenmez', async () => {
    const { token, userId } = await newUser();
    const id = newId();
    const first = await call('POST', '/water', { token, body: { id, amountMl: 2000 } });
    const replay = await call('POST', '/water', { token, body: { id, amountMl: 2000 } });
    expect([first.statusCode, replay.statusCode]).toEqual([201, 200]);
    expect(replay.json().data.totalMl).toBe(2000);

    const glass = (await call('POST', '/water', { token, body: { amountMl: 500 } })).json().data;
    expect(glass).toMatchObject({ totalMl: 2500, goalMl: 2500, goalReached: true, progress: 1 });
    expect(await stats(userId)).toMatchObject({ xp: 5, water_goal_days: 1 });

    const undo = (await call('DELETE', `/water/${glass.entries.at(-1).id}`, { token })).json().data;
    expect(undo).toMatchObject({ totalMl: 2000, goalReached: false });
    expect(await stats(userId)).toMatchObject({ xp: 0, water_goal_days: 0 });

    for (let i = 0; i < 4; i += 1)
      await call('POST', '/water', { token, body: { amountMl: 1100 } });
    const day = await get(token, '/water/day');
    expect(day.totalMl).toBe(6400);
    expect(day.warnings).toEqual(['HIGH_WATER_INTAKE']);

    const week = await get(token, '/water/week');
    expect(week.days).toHaveLength(7);
    expect(week.days.find((x) => x.isToday)).toMatchObject({ totalMl: 6400, goalReached: true });
    expect((await get(token, '/user/summary')).today.water).toEqual({ ml: 6400, goalMl: 2500 });

    // Başkasının kaydı yok sayılır.
    const other = await newUser();
    expect((await call('DELETE', `/water/${id}`, { token: other.token })).statusCode).toBe(404);
  });

  // ── Kilo ────────────────────────────────────────────────────────────
  it('kilo: kayıt, günlük XP (günde bir), grafik, özet, hedef, silme', async () => {
    const { token, userId } = await newUser();
    const t = today();
    const a = (
      await call('POST', '/weights', {
        token,
        body: { weightKg: 73.4, recordedAt: at(addDays(t, -2), '08:00') },
      })
    ).json().data.entry;
    await call('POST', '/weights', { token, body: { weightKg: 72.8 } });
    await call('POST', '/weights', { token, body: { weightKg: 72.6 } });
    // İki gün × 3 XP (bugünkü iki kayıt tek sayılır; onboarding kilosu sayılmaz).
    expect((await stats(userId)).xp).toBe(6);

    const chart = await get(token, '/weights/chart?range=day', { 'accept-language': 'tr' });
    expect(chart.buckets).toHaveLength(7);
    expect(chart.buckets[6]).toMatchObject({ from: t, weightKg: 72.6 });
    expect(chart.buckets[4]).toMatchObject({ weightKg: 73.4 });
    expect(chart.buckets[5].weightKg).toBeNull();
    expect(chart.yAxis).toEqual({ min: 60, max: 80 }); // hedef (64) de kapsanır
    expect(chart.goalKg).toBe(64);

    expect(await get(token, '/weights/summary')).toMatchObject({
      currentKg: 72.6,
      startKg: 74,
      goalKg: 64,
      changeKg: -1.4,
      progress: 0.14,
      bmi: 24.5,
      bmiCategory: 'normal',
      bmiBand: 'normal',
      heightCm: 172,
    });

    const goal = await call('PATCH', '/weights/goal', { token, body: { goalWeightKg: 66 } });
    expect(goal.statusCode).toBe(200);
    expect(goal.json().data).toMatchObject({ goalKg: 66 });

    const page = await get(token, '/weights?limit=2');
    expect(page.items.map((i) => i.weightKg)).toEqual([72.6, 72.8]);
    expect(page.pageInfo.hasMore).toBe(true);
    const rest = await get(token, `/weights?limit=2&cursor=${page.pageInfo.nextCursor}`);
    // Onboarding kilosu bugünün ilk kaydıdır; iki gün önceki ölçüm en eskisi.
    expect(rest.items.map((i) => i.weightKg)).toEqual([74, 73.4]);

    expect((await call('DELETE', `/weights/${a.id}`, { token })).statusCode).toBe(200);
    expect((await stats(userId)).xp).toBe(3);
  });

  it("oruç bitişinde girilen kilo günlük özete ve XP'ye yazılır", async () => {
    const { token, userId } = await newUser();
    const fast = (
      await call('POST', '/fasts', {
        token,
        body: { startedAt: new Date(Date.now() - 17 * 3_600_000).toISOString() },
      })
    ).json().data.fast;
    await call('POST', `/fasts/${fast.id}/finish`, { token, body: { weightKg: 71.9 } });
    const row = await ctx.db.one(
      'SELECT weight_kg FROM daily_summaries WHERE user_id = :id AND local_date = :d',
      { id: toBin(userId), d: today() },
    );
    expect(row.weight_kg).toBe(71.9);
    expect((await stats(userId)).xp).toBe(15 + 3);
  });

  // ── Adım ────────────────────────────────────────────────────────────
  it('kabul kriteri: sağlık senkronu manueli ezer, manuel senkronu ezemez (409)', async () => {
    const { token } = await newUser();
    const t = today();
    const manual = await call('PUT', `/steps/${t}`, { token, body: { steps: 5000 } });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().data.days[0]).toMatchObject({ steps: 5000, source: 'manual' });

    const sync = await call('POST', '/steps/sync', {
      token,
      body: {
        source: 'appleHealth',
        days: [
          { date: t, steps: 7200, distanceM: 5100 },
          { date: addDays(t, -1), steps: 9100 },
        ],
      },
    });
    expect(sync.json().data).toEqual({ updated: 2, skipped: 0 });

    const blocked = await call('PUT', `/steps/${t}`, { token, body: { steps: 100 } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.details).toMatchObject({
      reason: 'synced_day',
      source: 'appleHealth',
    });

    const week = await get(token, `/steps?range=week&date=${t}`);
    const day = week.days.find((d) => d.date === t);
    expect(day).toMatchObject({
      steps: 7200,
      distanceKm: 5.1,
      durationMin: 72,
      source: 'appleHealth',
    });
    expect(week.goal).toBe(8000);
    expect((await get(token, '/user/summary')).today.steps).toEqual({ count: 7200, goal: 8000 });

    expect(
      (await call('PUT', `/steps/${addDays(t, 1)}`, { token, body: { steps: 1 } })).statusCode,
    ).toBe(400);
  });

  // ── Uyku ────────────────────────────────────────────────────────────
  it('uyku: uyanış gününe yazılır, çakışma 409, özet ve senkron idempotent', async () => {
    const { token } = await newUser();
    const d = addDays(today(), -1);
    const night = await call('POST', '/sleep', {
      token,
      body: { sleepStart: at(addDays(d, -1), '23:00'), sleepEnd: at(d, '07:00'), quality: 4 },
    });
    expect(night.statusCode).toBe(201);
    expect(night.json().data.entry).toMatchObject({
      durationMinutes: 480,
      localDate: d,
      quality: 4,
    });

    const clash = await call('POST', '/sleep', {
      token,
      body: { sleepStart: at(d, '06:00'), sleepEnd: at(d, '08:00') },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.details.reason).toBe('sleep_overlap');

    await call('POST', '/sleep', {
      token,
      body: { sleepStart: at(d, '14:00'), sleepEnd: at(d, '14:30') },
    });
    const summary = await get(token, `/sleep/summary?date=${d}`);
    expect(summary.lastNight).toMatchObject({ durationMinutes: 480, totalMinutes: 510 });
    expect(summary).toMatchObject({ goalMin: 450, progress: 1 });
    expect(summary.week.at(-1)).toEqual({ date: d, minutes: 510 });

    // Program hiç ayarlanmadı: varsayılanlar öneri olarak gelir, kullanıcınınki sayılmaz.
    expect(summary.scheduleSet).toBe(false);
    await call('PATCH', '/user/goals', { token, body: { bedtime: '23:30' } });
    expect((await get(token, `/sleep/summary?date=${d}`)).scheduleSet).toBe(true);

    const body = {
      source: 'googleFit',
      entries: [
        {
          externalId: 'gf-1',
          sleepStart: at(addDays(d, -2), '23:30'),
          sleepEnd: at(addDays(d, -1), '06:30'),
        },
      ],
    };
    expect((await call('POST', '/sleep/sync', { token, body })).json().data).toEqual({
      created: 1,
      updated: 0,
    });
    expect((await call('POST', '/sleep/sync', { token, body })).json().data).toEqual({
      created: 0,
      updated: 1,
    });

    const tooLong = await call('POST', '/sleep', {
      token,
      body: { sleepStart: at(addDays(d, -5), '00:00'), sleepEnd: at(addDays(d, -5), '20:00') },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('gece doğrulaması takipçi günlerini aynı sonuca yeniden yazar', async () => {
    const { token, userId } = await newUser();
    await call('POST', '/water', { token, body: { amountMl: 2600 } });
    await call('POST', '/weights', { token, body: { weightKg: 73 } });
    await ctx.db.run(
      'UPDATE daily_summaries SET water_ml = 0, weight_kg = NULL WHERE user_id = :id',
      { id: toBin(userId) },
    );
    await ctx.db.run('UPDATE user_stats SET xp = 0 WHERE user_id = :id', { id: toBin(userId) });
    const { createStatsService } = await import('../../src/modules/stats/stats.service.js');
    await createStatsService({ db: ctx.db }).recompute(userId, { trackers: true });
    expect(await stats(userId)).toMatchObject({ xp: 8, water_goal_days: 1 });
  });
});
