import { AppError } from '../../shared/errors.js';
import { toApiEnum, toDbEnum } from '../../shared/enums.js';
import { newId } from '../../shared/ids.js';
import { addDays, localDate } from '../../shared/time.js';
import { assertInstant, fieldError } from './context.js';
import * as repo from './trackers.repository.js';
import { SLEEP_MAX_MINUTES } from './trackers.rules.js';

const SLEEP_PAST_DAYS = 31;
const DEFAULT_SLEEP_GOAL_MIN = 450;
const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

const toDto = (e) => ({
  id: e.id,
  sleepStart: e.sleepStart.toISOString(),
  sleepEnd: e.sleepEnd.toISOString(),
  durationMinutes: e.durationMinutes,
  localDate: e.localDate,
  quality: e.quality,
  source: toApiEnum(e.source),
});

/**
 * Uyku (docs/backend/04-api.md §10). Kayıt uyanış gününe yazılır; aynı gecenin kayıtları
 * çakışamaz (manuel). Sağlık senkronu `externalId` ile tekrar gönderilince aynı kaydı günceller.
 */
export function createSleepService({ db, ctx }) {
  function span(startIso, endIso, now, path = '') {
    const sleepStart = new Date(startIso);
    const sleepEnd = new Date(endIso);
    if (sleepEnd <= sleepStart) throw fieldError(`${path}sleepEnd`, 'must be after sleepStart');
    assertInstant(sleepEnd, now, { path: `${path}sleepEnd`, pastDays: SLEEP_PAST_DAYS });
    const durationMinutes = Math.floor((sleepEnd - sleepStart) / 60_000);
    if (durationMinutes > SLEEP_MAX_MINUTES) {
      throw fieldError(`${path}sleepEnd`, `sleep must not exceed ${SLEEP_MAX_MINUTES / 60} hours`);
    }
    return { sleepStart, sleepEnd, durationMinutes };
  }

  async function assertNoOverlap(conn, userId, s, excludeId) {
    const clash = await repo.overlappingSleep(
      db,
      conn,
      userId,
      s.sleepStart,
      s.sleepEnd,
      excludeId,
    );
    if (clash.length > 0) {
      throw new AppError('CONFLICT', { details: { reason: 'sleep_overlap', sleepIds: clash } });
    }
  }

  async function mustFind(userId, id, conn) {
    const e = await repo.findSleep(db, userId, id, conn);
    if (!e || e.foreign) throw new AppError('NOT_FOUND');
    return e;
  }

  const service = {
    async create(userId, body) {
      const s = span(body.sleepStart, body.sleepEnd, new Date());
      return ctx.write(userId, async (conn, { tz, touch }) => {
        if (body.id) {
          const existing = await repo.findSleep(db, userId, body.id, conn, {
            includeDeleted: true,
          });
          if (existing?.foreign)
            throw new AppError('CONFLICT', { details: { reason: 'id_taken' } });
          if (existing) return { created: false, entry: toDto(existing) };
        }
        await assertNoOverlap(conn, userId, s);
        const entry = {
          id: body.id ?? newId(),
          ...s,
          localDate: localDate(s.sleepEnd, tz),
          tz,
          quality: body.quality ?? null,
          source: 'manual',
        };
        await repo.insertSleep(db, conn, userId, entry);
        touch(entry.localDate);
        return { created: true, entry: toDto(entry) };
      });
    },

    async update(userId, id, body) {
      const now = new Date();
      return ctx.write(userId, async (conn, { tz, touch }) => {
        const e = await mustFind(userId, id, conn);
        const s = span(
          body.sleepStart ?? e.sleepStart.toISOString(),
          body.sleepEnd ?? e.sleepEnd.toISOString(),
          now,
        );
        await assertNoOverlap(conn, userId, s, id);
        const next = {
          ...s,
          localDate: localDate(s.sleepEnd, tz),
          quality: body.quality === undefined ? e.quality : body.quality,
        };
        await repo.updateSleep(db, conn, id, next);
        touch(e.localDate);
        touch(next.localDate);
        return { entry: toDto({ ...e, ...next }) };
      });
    },

    async remove(userId, id) {
      await ctx.write(userId, async (conn, { touch }) => {
        const e = await mustFind(userId, id, conn);
        await repo.softDeleteSleep(db, conn, id);
        touch(e.localDate);
      });
      return {};
    },

    /** POST /v1/sleep/sync — sağlık uygulamasından toplu aktarım; `externalId` ile idempotent. */
    async sync(userId, body) {
      const now = new Date();
      const source = toDbEnum(body.source);
      const spans = body.entries.map((e, i) => ({
        ...span(e.sleepStart, e.sleepEnd, now, `entries/${i}/`),
        externalId: e.externalId,
      }));
      return ctx.write(userId, async (conn, { tz, touch }) => {
        let created = 0;
        let updated = 0;
        for (const s of spans) {
          const localDay = localDate(s.sleepEnd, tz);
          const existing = await repo.findSleepByExternal(db, conn, userId, source, s.externalId);
          if (existing) {
            await repo.updateSleep(db, conn, existing.id, { ...s, localDate: localDay });
            touch(existing.localDate);
            updated += 1;
          } else {
            await repo.insertSleep(db, conn, userId, {
              id: newId(),
              ...s,
              localDate: localDay,
              tz,
              source,
            });
            created += 1;
          }
          touch(localDay);
        }
        return { created, updated };
      });
    },

    /** Son gece (uyanış günü `date`), hedef, program ve son 7 gün. */
    async summary(userId, date) {
      const { today } = await ctx.zone(userId);
      const day = date ?? today;
      const from = addDays(day, -6);
      const [entries, summaries, goals] = await Promise.all([
        repo.sleepOfDay(db, userId, day),
        repo.summariesBetween(db, userId, { from, to: day }),
        repo.goals(db, userId),
      ]);
      const goalMin = goals?.sleep_goal_min ?? DEFAULT_SLEEP_GOAL_MIN;
      const totalMinutes = entries.reduce((sum, e) => sum + e.durationMinutes, 0);
      const main = entries.toSorted((a, b) => b.durationMinutes - a.durationMinutes)[0];
      const week = [];
      for (let d = from; d <= day; d = addDays(d, 1)) {
        week.push({ date: d, minutes: summaries.get(d)?.sleep_minutes ?? 0 });
      }
      return {
        date: day,
        // En uzun kayıt gece uykusudur; şekerlemeler toplam süreye girer.
        lastNight: main ? { ...toDto(main), totalMinutes } : null,
        goalMin,
        progress: Math.min(1, Math.round((totalMinutes / goalMin) * 1000) / 1000),
        schedule: { bedtime: hhmm(goals?.bedtime), wakeTime: hhmm(goals?.wake_time) },
        // false: yatış / uyanış / hedef hiç ayarlanmadı; değerler varsayılandır (öneri).
        scheduleSet: Boolean(goals?.sleep_schedule_set_at),
        week,
      };
    },
  };
  return service;
}
