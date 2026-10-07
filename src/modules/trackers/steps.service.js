import { AppError } from '../../shared/errors.js';
import { toDbEnum, toApiEnum } from '../../shared/enums.js';
import { addDays, mondayOf } from '../../shared/time.js';
import * as userRepo from '../user/user.repository.js';
import { assertLocalDay } from './context.js';
import * as repo from './trackers.repository.js';
import { stepMetrics, stepOverwriteAllowed } from './trackers.rules.js';

/** Manuel ve senkron kayıtlar için geriye dönük sınır (sağlık senkronu 31 güne kadar). */
const STEPS_PAST_DAYS = 31;
const DEFAULT_STEPS_GOAL = 8000;

/**
 * Adım (docs/backend/04-api.md §9, 05 §8). Kaynak önceliği: sağlık senkronu manuelin üzerine
 * yazar; manuel giriş senkronlanmış günü ezemez (409).
 */
export function createStepsService({ db, ctx }) {
  async function write(userId, days, source) {
    return ctx.write(userId, async (conn, { today, touch }) => {
      days.forEach((d, i) =>
        assertLocalDay(d.date, today, { path: `days/${i}/date`, pastDays: STEPS_PAST_DAYS }),
      );
      let updated = 0;
      let skipped = 0;
      for (const d of days) {
        const existing = await repo.findSteps(db, userId, d.date, conn, { forUpdate: true });
        if (!stepOverwriteAllowed(existing?.source, source)) {
          if (source === 'manual') {
            throw new AppError('CONFLICT', {
              details: { reason: 'synced_day', date: d.date, source: toApiEnum(existing.source) },
            });
          }
          skipped += 1;
          continue;
        }
        await repo.upsertSteps(db, conn, userId, { ...d, source });
        touch(d.date);
        updated += 1;
      }
      return { updated, skipped };
    });
  }

  const service = {
    /** PUT /v1/steps/:date — manuel giriş. */
    async put(userId, date, body) {
      await write(userId, [{ date, steps: body.steps }], 'manual');
      return service.list(userId, { range: 'day', date });
    },

    /** POST /v1/steps/sync — sağlık uygulamasından toplu aktarım (en fazla 31 gün). */
    async sync(userId, body) {
      const days = body.days.map((d) => ({
        date: d.date,
        steps: d.steps,
        distanceM: d.distanceM,
        activeKcal: d.activeKcal,
      }));
      return write(userId, days, toDbEnum(body.source));
    },

    /** range: day | week (Pzt–Paz) | month (takvim ayı). */
    async list(userId, { range = 'week', date }) {
      const { today } = await ctx.zone(userId);
      const anchor = date ?? today;
      let from = anchor;
      let to = anchor;
      if (range === 'week') {
        from = mondayOf(anchor);
        to = addDays(from, 6);
      } else if (range === 'month') {
        from = `${anchor.slice(0, 8)}01`;
        to = addDays(`${addDays(from, 31).slice(0, 8)}01`, -1);
      }
      const [rows, goals, profile] = await Promise.all([
        repo.stepsBetween(db, userId, { from, to }),
        repo.goals(db, userId),
        userRepo.getProfile(db, userId),
      ]);
      const body = {
        heightCm: profile?.height_cm ?? null,
        weightKg: profile?.current_weight_kg ?? profile?.start_weight_kg ?? null,
      };
      const goal = goals?.steps_goal ?? DEFAULT_STEPS_GOAL;
      const days = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const r = rows.get(d);
        const steps = r?.steps ?? 0;
        const derived = stepMetrics(steps, body);
        days.push({
          date: d,
          steps,
          // Sağlık uygulamasının ölçtüğü değer varsa o, yoksa kişisel formül.
          distanceKm: r?.distance_m ? Math.round(r.distance_m / 10) / 100 : derived.distanceKm,
          kcal: r?.active_kcal ?? derived.kcal,
          durationMin: derived.durationMin,
          progress: Math.min(1, Math.round((steps / goal) * 1000) / 1000),
          source: r ? toApiEnum(r.source) : null,
          isFuture: d > today,
        });
      }
      return { range, from, to, goal, days };
    },
  };
  return service;
}
