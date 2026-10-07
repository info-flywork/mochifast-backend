import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { addDays, localDate, mondayOf } from '../../shared/time.js';
import { assertInstant } from './context.js';
import * as repo from './trackers.repository.js';
import { waterWarnings } from './trackers.rules.js';

/** Geçmiş güne su eklenebilen süre (unutulan bardaklar). */
const WATER_PAST_DAYS = 7;
const DEFAULT_GOAL_ML = 2500;
const DEFAULT_GLASS_ML = 300;

const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);

/**
 * Su (docs/backend/04-api.md §8, 05 §12). Toplam, kaydın yerel gününe göre hesaplanır: 23:50'de
 * içilen o güne, 00:10'da içilen ertesi güne yazılır; gece yarısı sıfırlaması kendiliğindendir.
 */
export function createWaterService({ db, ctx }) {
  /** Bugün için geçerli hedef; geçmiş gün için o günün anlık görüntüsü. */
  function goalFor(date, today, summary, goals) {
    const current = goals?.water_goal_ml ?? DEFAULT_GOAL_ML;
    return date < today ? (summary?.water_goal_ml ?? current) : current;
  }

  const service = {
    async day(userId, date) {
      const { today } = await ctx.zone(userId);
      const day = date ?? today;
      const [entries, summaries, goals] = await Promise.all([
        repo.waterOfDay(db, userId, day),
        repo.summariesBetween(db, userId, { from: day, to: day }),
        repo.goals(db, userId),
      ]);
      const totalMl = entries.reduce((sum, e) => sum + e.amountMl, 0);
      const goalMl = goalFor(day, today, summaries.get(day), goals);
      return {
        date: day,
        totalMl,
        goalMl,
        progress: Math.min(1, ratio(totalMl, goalMl)),
        goalReached: totalMl >= goalMl,
        glassSizeMl: goals?.glass_size_ml ?? DEFAULT_GLASS_ML,
        entries: entries.map((e) => ({
          id: e.id,
          amountMl: e.amountMl,
          loggedAt: e.loggedAt.toISOString(),
          source: e.source,
        })),
        warnings: waterWarnings(totalMl),
      };
    },

    /** POST /v1/water — yanıt güncel gün özetidir. İstemci `id` ile tekrar gönderim yinelenmez. */
    async add(userId, body) {
      const now = new Date();
      const loggedAt = body.loggedAt ? new Date(body.loggedAt) : now;
      assertInstant(loggedAt, now, { path: 'loggedAt', pastDays: WATER_PAST_DAYS });
      const { created, date } = await ctx.write(userId, async (conn, { tz, touch }) => {
        if (body.id) {
          const existing = await repo.findWater(db, userId, body.id, conn, {
            includeDeleted: true,
          });
          if (existing?.foreign)
            throw new AppError('CONFLICT', { details: { reason: 'id_taken' } });
          if (existing) return { created: false, date: existing.localDate };
        }
        const entry = {
          id: body.id ?? newId(),
          amountMl: body.amountMl,
          loggedAt,
          localDate: localDate(loggedAt, tz),
          tz,
          source: body.source ?? 'app',
        };
        await repo.insertWater(db, conn, userId, entry);
        touch(entry.localDate);
        return { created: true, date: entry.localDate };
      });
      return { created, day: await service.day(userId, date) };
    },

    /** Geri al: kaydı siler, güncel gün özetini döner. */
    async remove(userId, id) {
      const date = await ctx.write(userId, async (conn, { touch }) => {
        const e = await repo.findWater(db, userId, id, conn);
        if (!e || e.foreign) throw new AppError('NOT_FOUND');
        await repo.softDeleteWater(db, conn, id);
        touch(e.localDate);
        return e.localDate;
      });
      return service.day(userId, date);
    },

    /** Pzt–Paz hafta. */
    async week(userId, date) {
      const { today } = await ctx.zone(userId);
      const from = mondayOf(date ?? today);
      const to = addDays(from, 6);
      const [summaries, goals] = await Promise.all([
        repo.summariesBetween(db, userId, { from, to }),
        repo.goals(db, userId),
      ]);
      const days = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const s = summaries.get(d);
        const totalMl = s?.water_ml ?? 0;
        const goalMl = goalFor(d, today, s, goals);
        days.push({
          date: d,
          totalMl,
          goalMl,
          progress: Math.min(1, ratio(totalMl, goalMl)),
          goalReached: totalMl >= goalMl,
          isToday: d === today,
          isFuture: d > today,
        });
      }
      return { weekStart: from, days };
    },
  };
  return service;
}
