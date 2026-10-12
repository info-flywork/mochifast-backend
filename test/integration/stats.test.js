import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { statsJobs } from '../../src/jobs/stats.jobs.js';
import { createStatsService } from '../../src/modules/stats/stats.service.js';
import { newId, toBin } from '../../src/shared/ids.js';
import { addDays, isoWeekday, mondayOf } from '../../src/shared/time.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const TZ = 'Europe/Istanbul';
const H = 3_600_000;
const silent = { info() {}, error() {}, debug() {} };

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
/** `daysAgo` gün önce yerel 06:00'da biten 16 saatlik oruç (ardışık günler çakışmaz). */
function pastFast(daysAgo) {
  const end = DateTime.fromISO(`${addDays(today(), -daysAgo)}T06:00`, { zone: TZ });
  return { startedAt: end.minus({ hours: 16 }).toISO(), endedAt: end.toISO() };
}

describe.skipIf(!mysqlUrl)('seri, XP ve özetler (gerçek MySQL)', () => {
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
  const get = async (token, url) => (await call('GET', url, { token })).json().data;

  it('geçmiş oruçlar → seri, sayaçlar, kilometre taşı XP; bitirme yanıtı seviye atlatır', async () => {
    const { token } = await newUser();
    const ids = {};
    for (const d of [5, 4, 3, 2, 1]) {
      const res = await call('POST', '/fasts/manual', { token, body: pastFast(d) });
      expect(res.statusCode).toBe(201);
      ids[d] = res.json().data.fast.id;
    }
    // 5 × 15 XP + 3 günlük seri taşı (20) = 95; bugün henüz oruç yok ama seri sürüyor.
    expect(await get(token, '/user/progress')).toMatchObject({
      level: 1,
      xp: 95,
      nextLevelXp: 100,
      streakDays: 5,
      bestStreak: 5,
      completedFasts: 5,
      totalFasts: 5,
      totalFastedMinutes: 4800,
    });

    const fast = (
      await call('POST', '/fasts', {
        token,
        body: { startedAt: new Date(Date.now() - 17 * H).toISOString() },
      })
    ).json().data.fast;
    const finish = (await call('POST', `/fasts/${fast.id}/finish`, { token, body: {} })).json()
      .data;
    expect(finish).toMatchObject({
      streak: { current: 6, best: 6, increased: true },
      xpGained: 15,
      levelUp: { from: 1, to: 2 },
      // Elle girilmiş tamamlanmış oruç zaten var: kutlama tekrar gösterilmez.
      isFirstFast: false,
    });

    // Hafta şeridi: bugün tutuldu; içinde bulunulan haftadaki geçmiş günler 960 dk.
    const week = await get(token, '/fasts/week');
    expect(week.weekStart).toBe(mondayOf(today()));
    expect(week.days).toHaveLength(7);
    const todayRow = week.days.find((d) => d.isToday);
    expect(todayRow).toMatchObject({ kept: true, progress: 1, goalMinutes: 960 });
    expect(todayRow.fastedMinutes).toBeGreaterThanOrEqual(1020);
    for (const d of week.days) {
      const ago = Math.round((Date.parse(today()) - Date.parse(d.date)) / 86_400_000);
      if (ago >= 1 && ago <= 5) expect(d).toMatchObject({ fastedMinutes: 960, kept: true });
      if (ago < 0) expect(d).toMatchObject({ isFuture: true, kept: null });
    }

    // 3 gün önceki orucu silmek seriyi böler ve XP'yi deterministik olarak yeniden hesaplar.
    expect((await call('DELETE', `/fasts/${ids[3]}`, { token })).statusCode).toBe(200);
    // Kalan 5 oruç × 15 + yeni serinin (dün, önceki gün, bugün) 3 taşı = 95 → seviye 1'e döner.
    expect(await get(token, '/user/progress')).toMatchObject({
      streakDays: 3,
      bestStreak: 3,
      xp: 95,
      level: 1,
      completedFasts: 5,
    });

    const stats = await get(token, '/fasts/stats?range=week');
    expect(stats).toMatchObject({ range: 'week', bucketSize: 'day', to: today() });
    expect(stats.buckets).toHaveLength(7);
    expect(stats.totals).toMatchObject({ fasts: 5, completedFasts: 5, completionRate: 1 });
    expect(stats.totals.longestFastMinutes).toBeGreaterThanOrEqual(1020);

    const all = await get(token, '/fasts/stats?range=all');
    expect(all.bucketSize).toBe('month');
    expect(all.buckets.reduce((a, b) => a + b.fasts, 0)).toBe(5);

    expect(await get(token, '/user/stats?range=all')).toMatchObject({
      fasts: 5,
      currentStreak: 3,
      bestStreak: 3,
      waterGoalDays: 0,
    });
  });

  it('düzenleme: süreyi %80 altına çekmek o günü düşürür', async () => {
    const { token } = await newUser();
    const created = [];
    for (const d of [2, 1]) {
      created.push((await call('POST', '/fasts/manual', { token, body: pastFast(d) })).json().data);
    }
    expect((await get(token, '/user/progress')).streakDays).toBe(2);
    const yesterday = created[1].fast;
    const shorter = new Date(Date.parse(yesterday.startedAt) + 12 * H).toISOString();
    await call('PATCH', `/fasts/${yesterday.id}`, { token, body: { endedAt: shorter } });
    expect(await get(token, '/user/progress')).toMatchObject({ streakDays: 0, bestStreak: 1 });
  });

  it('gün dönümü: bayat seri okunurken bugüne göre yeniden hesaplanır', async () => {
    const { token, userId } = await newUser();
    await ctx.db.run(
      `UPDATE user_stats SET current_streak = 42, best_streak = 42,
              streak_last_date = DATE_SUB(CURDATE(), INTERVAL 3 DAY) WHERE user_id = :id`,
      { id: toBin(userId) },
    );
    expect(await get(token, '/user/progress')).toMatchObject({ streakDays: 0, bestStreak: 0 });
  });

  it('özet: profil, ilerleme, plan, hafta ve bugün tek yanıtta', async () => {
    const { token, userId } = await newUser();
    const s = await get(token, '/user/summary');
    expect(s.user).toMatchObject({ id: userId, isGuest: true, isPremium: false });
    expect(s.progress).toMatchObject({ level: 1, streakDays: 0 });
    expect(s.plan).toMatchObject({ planCode: '16_8', fastMinutes: 960 });
    // `/plans/current` ile aynı DTO (timing dahil): istemci planı özetten ezince bilgi kaybolmaz.
    expect(s.plan).toEqual((await get(token, '/plans/current')).plan);
    expect(s.pendingPlanCode).toBeNull();
    expect(s.activeFast).toBeNull();
    expect(s.week).toHaveLength(7);
    expect(s.today).toMatchObject({ date: today(), water: { ml: 0 }, hunger: { physical: 0 } });
    expect(s.weight).toEqual({ currentKg: 74, startKg: 74, goalKg: 64, progress: 0 });
  });

  it('otomatik kapanış: 72 saati geçen oruç hedefte biter ve sayılır', async () => {
    const { token, userId } = await newUser();
    const fast = (
      await call('POST', '/fasts', {
        token,
        body: { startedAt: new Date(Date.now() - 6.5 * 24 * H).toISOString() },
      })
    ).json().data.fast;
    const jobs = statsJobs({
      db: ctx.db,
      stats: createStatsService({ db: ctx.db }),
      logger: silent,
    });
    await jobs.fastAutoclose();
    const closed = (await get(token, `/fasts/${fast.id}`)).fast;
    expect(closed).toMatchObject({
      status: 'completed',
      autoClosed: true,
      durationMinutes: 960,
      goalReached: true,
      endedAt: fast.plannedEndAt,
    });
    const stats = await ctx.db.one(
      'SELECT completed_fasts, xp FROM user_stats WHERE user_id = :id',
      {
        id: toBin(userId),
      },
    );
    expect(stats).toMatchObject({ completed_fasts: 1, xp: 15 });
    // İdempotent: tekrar çalışması bir şey değiştirmez.
    await jobs.fastAutoclose();
    expect((await get(token, `/fasts/${fast.id}`)).fast.durationMinutes).toBe(960);

    // Gece doğrulaması ve gün dönümü aynı sonucu üretir (deterministik yeniden hesaplama).
    await jobs.dailyRollup();
    await jobs.dayRollover();
    expect(
      await ctx.db.one('SELECT completed_fasts, xp FROM user_stats WHERE user_id = :id', {
        id: toBin(userId),
      }),
    ).toMatchObject({ completed_fasts: 1, xp: 15 });
  });

  it('haftalık plan: nötr günler seriyi sürdürür, azaltılmış gün check-in ister', async () => {
    const { token, userId } = await newUser({ onboard: false });
    const t = today();
    const reducedDow = isoWeekday(addDays(t, -2));
    const schedule = [1, 2, 3, 4, 5, 6, 7].map((dow) =>
      dow === reducedDow ? { dow, type: 'reduced', kcal: 500 } : { dow, type: 'normal' },
    );
    // Premium planlar F8'e kadar API'den seçilemez: plan satırı doğrudan eklenir.
    await ctx.db.run(
      `INSERT INTO user_plans (id, user_id, plan_id, fast_minutes, weekly_schedule, started_on)
       VALUES (:id, :userId, (SELECT id FROM fasting_plans WHERE code = '5_2'), 960, :schedule, :startedOn)`,
      {
        id: toBin(newId()),
        userId: toBin(userId),
        schedule: JSON.stringify(schedule),
        startedOn: addDays(t, -5),
      },
    );
    // -5..-3 nötr (3), -2 azaltılmış ve tutulmadı → sıfır, -1 ve bugün nötr → 2.
    expect((await get(token, '/user/progress')).streakDays).toBe(2);

    const res = await call('PUT', `/plans/days/${addDays(t, -2)}`, {
      token,
      body: { status: 'done' },
    });
    expect(res.statusCode).toBe(200);
    expect(await get(token, '/user/progress')).toMatchObject({ streakDays: 6, xp: 20 });

    const day = (await get(token, '/fasts/week')).days.find((d) => d.date === addDays(t, -2));
    if (day)
      expect(day).toMatchObject({ dayType: 'reduced', checkin: 'done', kept: true, progress: 1 });
  });
});
