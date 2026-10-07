import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { createPushClient } from '../../src/infra/fcm.js';
import { notificationJobs } from '../../src/jobs/notifications.jobs.js';
import * as notify from '../../src/modules/notifications/notify.js';
import { planDailyReminders } from '../../src/modules/notifications/planner.js';
import { toBin } from '../../src/shared/ids.js';
import { createIntegrationApp, fakePush } from '../helpers/app.js';

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

describe.skipIf(!mysqlUrl)(
  'bildirimler: planlama, gönderim, inbox (gerçek MySQL, sahte FCM)',
  () => {
    let ctx;
    let call;
    let fcm;
    let jobs;

    beforeAll(async () => {
      ctx = await createIntegrationApp(mysqlUrl);
      ({ call } = ctx);
    });

    beforeEach(() => {
      fcm = fakePush();
      jobs = notificationJobs({
        db: ctx.db,
        config: ctx.config,
        logger: silent,
        push: createPushClient({}, { sendImpl: (m) => fcm.sendImpl(m) }),
      });
    });

    afterAll(async () => {
      await ctx?.close();
    });

    /** Onboard edilmiş, push token'lı kullanıcı; `oldDays` > 3 ise yeni kullanıcı sessiz dönemi geçer. */
    async function newUser({ oldDays = 10, quiet = ['00:00', '00:00'] } = {}) {
      const installId = randomUUID();
      const { token, user } = (await ctx.guest(installId, { timezone: TZ, locale: 'tr' })).json()
        .data;
      await call('POST', '/user/onboarding', {
        token: token.accessToken,
        body: onboardingBody,
        headers: { 'x-timezone': TZ },
      });
      const pushToken = `fcm-${randomUUID()}`;
      const dev = await call('PUT', '/devices/current', {
        token: token.accessToken,
        body: { installId, platform: 'ios', pushToken, pushEnabled: true },
      });
      expect(dev.statusCode).toBe(200);
      await ctx.db.run(
        `UPDATE users SET created_at = DATE_SUB(NOW(3), INTERVAL :d DAY) WHERE id = :id`,
        { d: oldDays, id: toBin(user.id) },
      );
      await call('PATCH', '/user/settings', {
        token: token.accessToken,
        body: { quietHours: { start: quiet[0], end: quiet[1] } },
      });
      return { token: token.accessToken, userId: user.id, pushToken };
    }

    const scheduled = (userId, key) =>
      ctx.db.one(
        `SELECT status, fire_at, last_error, pushed FROM scheduled_notifications
        WHERE user_id = :u AND dedupe_key = :k`,
        { u: toBin(userId), k: key },
      );
    const makeDue = (userId, key) =>
      ctx.db.run(
        `UPDATE scheduled_notifications SET fire_at = DATE_SUB(NOW(3), INTERVAL 1 SECOND)
        WHERE user_id = :u AND dedupe_key = :k`,
        { u: toBin(userId), k: key },
      );
    /** Worker döngüsü: dağıt → kuyruktaki gönderim işlerini çalıştır. */
    async function runWorker() {
      await jobs.notificationDispatch();
      const queued = await ctx.db.many(
        "SELECT id, payload FROM jobs WHERE queue = 'notifications' AND name = 'pushSend' AND status = 'pending'",
      );
      for (const j of queued) {
        const payload = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload;
        await jobs.pushSend({ payload, attempt: 1, maxAttempts: 3 });
        await ctx.db.run("UPDATE jobs SET status = 'done' WHERE id = :id", { id: j.id });
      }
    }

    it("kabul kriteri: 16 sa oruçta hedef push'u planlanan anda gider; erken bitirilirse gitmez", async () => {
      const u = await newUser();
      const fast = (await call('POST', '/fasts', { token: u.token, body: {} })).json().data.fast;
      const goal = await scheduled(u.userId, `fast:${fast.id}:goal`);
      expect(goal.status).toBe('scheduled');
      expect(Math.abs(goal.fire_at.getTime() - new Date(fast.plannedEndAt).getTime())).toBeLessThan(
        1000,
      );
      expect((await scheduled(u.userId, `fast:${fast.id}:stage`)).status).toBe('scheduled');
      expect((await scheduled(u.userId, `fast:${fast.id}:half`)).status).toBe('scheduled');

      await makeDue(u.userId, `fast:${fast.id}:goal`);
      await runWorker();
      expect(fcm.sent).toHaveLength(1);
      expect(fcm.sent[0]).toMatchObject({
        token: u.pushToken,
        notification: { title: 'Başardın! 🎉' },
        data: { type: 'fast_goal_reached', deepLink: 'fastingapp://fasting' },
      });
      expect((await scheduled(u.userId, `fast:${fast.id}:goal`)).status).toBe('sent');
      const inbox = (await call('GET', '/notifications', { token: u.token })).json().data.items;
      expect(inbox[0]).toMatchObject({
        type: 'fast_goal_reached',
        title: 'Başardın! 🎉',
        category: 'fasting',
      });

      // İkinci oruç erken biter: kalan bildirimler iptal, yeme penceresi bildirimleri kurulur.
      const v = await newUser();
      const f2 = (
        await call('POST', '/fasts', {
          token: v.token,
          body: { startedAt: new Date(Date.now() - 2 * H).toISOString() },
        })
      ).json().data.fast;
      await call('POST', `/fasts/${f2.id}/finish`, { token: v.token, body: {} });
      expect((await scheduled(v.userId, `fast:${f2.id}:goal`)).status).toBe('cancelled');
      expect((await scheduled(v.userId, `eat:${f2.id}:ended`)).status).toBe('scheduled');
      await makeDue(v.userId, `fast:${f2.id}:goal`);
      await runWorker();
      expect(fcm.sent.filter((m) => m.token === v.pushToken)).toHaveLength(0);
    });

    it('kabul kriteri: sessiz saatte su hatırlatması ertelenir; kategori kapalıysa push gitmez', async () => {
      const local = DateTime.now().setZone(TZ);
      const start = local.minus({ minutes: 30 }).toFormat('HH:mm');
      const end = local.plus({ minutes: 30 }).toFormat('HH:mm');
      const u = await newUser({ quiet: [start, end] });
      await call('PATCH', '/user/settings', {
        token: u.token,
        body: { notifications: { water: true } },
      });
      await ctx.db.withTransaction((conn) =>
        notify.schedule(ctx.db, conn, u.userId, {
          type: 'water_reminder',
          dedupeKey: 'water:test:1',
        }),
      );
      await runWorker();
      const deferred = await scheduled(u.userId, 'water:test:1');
      expect(deferred).toMatchObject({ status: 'scheduled', last_error: 'quiet_hours_deferred' });
      expect(deferred.fire_at.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000);
      expect(fcm.sent).toHaveLength(0);

      // Sessiz saat dışı, su kategorisi kapalı → atlanır.
      const w = await newUser();
      await ctx.db.withTransaction((conn) =>
        notify.schedule(ctx.db, conn, w.userId, {
          type: 'water_reminder',
          dedupeKey: 'water:test:2',
        }),
      );
      await runWorker();
      expect(await scheduled(w.userId, 'water:test:2')).toMatchObject({
        status: 'skipped',
        last_error: 'category_off',
      });

      await call('PATCH', '/user/settings', {
        token: w.token,
        body: { notifications: { water: true } },
      });
      await ctx.db.withTransaction((conn) =>
        notify.schedule(ctx.db, conn, w.userId, {
          type: 'water_reminder',
          dedupeKey: 'water:test:3',
        }),
      );
      await runWorker();
      expect(await scheduled(w.userId, 'water:test:3')).toMatchObject({
        status: 'sent',
        pushed: true,
      });
      expect(fcm.sent[0].notification.title).toBe('Su zamanı 💧');
    });

    it("kabul kriteri: geçersiz FCM token'ı otomatik temizlenir", async () => {
      const u = await newUser();
      fcm.fail[u.pushToken] = 'messaging/registration-token-not-registered';
      await ctx.db.withTransaction((conn) =>
        notify.schedule(ctx.db, conn, u.userId, {
          type: 'streak_milestone',
          params: { streak: 7 },
          dedupeKey: 'test:milestone',
        }),
      );
      await runWorker();
      const device = await ctx.db.one('SELECT push_token FROM devices WHERE user_id = :u', {
        u: toBin(u.userId),
      });
      expect(device.push_token).toBeNull();
      const delivery = await ctx.db.one(
        'SELECT status, error_code FROM push_deliveries WHERE user_id = :u',
        {
          u: toBin(u.userId),
        },
      );
      expect(delivery).toEqual({
        status: 'invalid_token',
        error_code: 'messaging/registration-token-not-registered',
      });
      // Inbox kanalı da olduğu için kayıt yine düşer.
      const inbox = (await call('GET', '/notifications', { token: u.token })).json().data.items;
      expect(inbox[0]).toMatchObject({ type: 'streak_milestone', title: '7 günlük seri! 🏆' });
    });

    it('günlük sınır (kategori ≤ 3) ve yeni kullanıcı sessiz dönemi', async () => {
      const u = await newUser();
      for (let i = 0; i < 4; i += 1) {
        await ctx.db.withTransaction((conn) =>
          notify.schedule(ctx.db, conn, u.userId, {
            type: 'streak_milestone',
            params: { streak: 3 + i },
            dedupeKey: `cap:${i}`,
          }),
        );
      }
      await runWorker();
      expect(fcm.sent).toHaveLength(3);
      expect((await scheduled(u.userId, 'cap:3')).last_error).toBe('category_limit');

      const fresh = await newUser({ oldDays: 0 });
      await ctx.db.withTransaction((conn) =>
        notify.schedule(ctx.db, conn, fresh.userId, {
          type: 'world_level_up',
          params: { zone: 'forest', level: 1 },
          dedupeKey: 'new:1',
        }),
      );
      await runWorker();
      expect(await scheduled(fresh.userId, 'new:1')).toMatchObject({
        status: 'sent',
        pushed: false,
        last_error: 'new_user_quiet_period',
      });
      const inbox = (await call('GET', '/notifications', { token: fresh.token })).json().data.items;
      expect(inbox[0]).toMatchObject({ title: 'Orman büyüdü! 🌱' });
    });

    it('gelen kutusu: kilo güncellemesi dilde render; okundu, tümü okundu, sil', async () => {
      const u = await newUser();
      await call('POST', '/weights', { token: u.token, body: { weightKg: 72.4 } });
      await runWorker();
      const list = (await call('GET', '/notifications', { token: u.token })).json().data.items;
      // Kilo zirve bölgesini de büyüttü: dünya bildirimi de kutuda.
      expect(list.map((n) => n.type).sort()).toEqual(['weight_update', 'world_level_up']);
      const weight = list.find((n) => n.type === 'weight_update');
      expect(weight).toMatchObject({
        title: 'Kilo güncellemeleri',
        body: 'Yeni kaydedilen kilon: 72,4 kg',
        params: { weightKg: 72.4 },
        deepLink: 'fastingapp://body-history',
        readAt: null,
      });
      // Kilo yalnızca inbox; dünya bildirimi push'la da gider (değer içermez).
      expect(fcm.sent.map((m) => m.data.type)).toEqual(['world_level_up']);
      const en = (
        await call('GET', '/notifications', {
          token: u.token,
          headers: { 'accept-language': 'en' },
        })
      ).json().data.items;
      expect(en.find((n) => n.type === 'weight_update').body).toBe(
        'Your new recorded weight is 72.4 kg',
      );

      const unread = async () =>
        (await call('GET', '/notifications/unread-count', { token: u.token })).json().data.count;
      expect(await unread()).toBe(2);
      await call('POST', `/notifications/${weight.id}/read`, { token: u.token });
      expect(await unread()).toBe(1);
      expect((await call('POST', '/notifications/read-all', { token: u.token })).statusCode).toBe(
        200,
      );
      expect(await unread()).toBe(0);
      await call('DELETE', `/notifications/${weight.id}`, { token: u.token });
      expect(
        (await call('GET', '/notifications', { token: u.token })).json().data.items,
      ).toHaveLength(1);
      const other = await newUser();
      expect(
        (await call('POST', `/notifications/${weight.id}/read`, { token: other.token })).statusCode,
      ).toBe(404);
    });

    it('günlük planlayıcı: yerel gece yarısında su, seri dürtmesi ve oruç başlatma hatırlatmaları', async () => {
      const u = await newUser();
      await call('PATCH', '/user/settings', {
        token: u.token,
        body: { notifications: { water: true } },
      });
      await ctx.db.run('UPDATE user_stats SET current_streak = 4 WHERE user_id = :u', {
        u: toBin(u.userId),
      });
      const midnight = DateTime.now()
        .setZone(TZ)
        .plus({ days: 1 })
        .startOf('day')
        .plus({ minutes: 5 });
      await planDailyReminders(ctx.db, { now: midnight.toJSDate() });
      const day = midnight.toISODate();
      const rows = await ctx.db.many(
        'SELECT type, dedupe_key FROM scheduled_notifications WHERE user_id = :u ORDER BY fire_at',
        { u: toBin(u.userId) },
      );
      const keys = rows.map((r) => r.dedupe_key);
      // Varsayılan uyanış 06:30 → ilk su saati 07:30.
      expect(keys).toContain(`water:${day}:07:30`);
      expect(keys).toContain(`streak_nudge:${day}`);
      expect(keys).toContain(`fast_start:${day}`);
      // Tekrar çalışması yinelemez.
      await planDailyReminders(ctx.db, { now: midnight.toJSDate() });
      const again = await ctx.db.one(
        'SELECT COUNT(*) AS n FROM scheduled_notifications WHERE user_id = :u',
        { u: toBin(u.userId) },
      );
      expect(Number(again.n)).toBe(rows.length);
    });

    it('günlük planlayıcı (DST): gece yarısının yaşanmadığı gün ve kaçırılan saatte de bir kez planlar', async () => {
      const u = await newUser();
      await ctx.db.run("UPDATE users SET timezone = 'America/Santiago' WHERE id = :u", {
        u: toBin(u.userId),
      });
      await ctx.db.run('UPDATE user_stats SET current_streak = 3 WHERE user_id = :u', {
        u: toBin(u.userId),
      });
      const count = async () =>
        Number(
          (
            await ctx.db.one(
              "SELECT COUNT(*) AS n FROM scheduled_notifications WHERE user_id = :u AND dedupe_key = 'streak_nudge:2026-09-06'",
              { u: toBin(u.userId) },
            )
          ).n,
        );
      // 6 Eylül 2026: Santiago'da 00:00 → 01:00; 23:30 (5 Eylül) ve 01:30 (6 Eylül) yerel.
      await planDailyReminders(ctx.db, { now: new Date('2026-09-06T03:30:00Z') });
      await planDailyReminders(ctx.db, { now: new Date('2026-09-06T04:30:00Z') });
      expect(await count()).toBe(1);
      // Aynı gün sonraki saatler tekrar planlamaz (dilim günü işaretli).
      await ctx.db.run('DELETE FROM scheduled_notifications WHERE user_id = :u', {
        u: toBin(u.userId),
      });
      await planDailyReminders(ctx.db, { now: new Date('2026-09-06T06:30:00Z') });
      expect(await count()).toBe(0);
      // Worker gece kapalıydı: ertesi günün ilk çalışması 03:10'da da planlar.
      await planDailyReminders(ctx.db, { now: new Date('2026-09-07T06:10:00Z') });
      const next = await ctx.db.one(
        "SELECT COUNT(*) AS n FROM scheduled_notifications WHERE user_id = :u AND dedupe_key = 'streak_nudge:2026-09-07'",
        { u: toBin(u.userId) },
      );
      expect(Number(next.n)).toBe(1);
    });
  },
);
