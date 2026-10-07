import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination.js';
import { localDate } from '../../shared/time.js';
import { bmi, projection, DEFAULT_WEEKLY_LOSS_KG } from '../user/onboarding.rules.js';
import * as userRepo from '../user/user.repository.js';
import { assertInstant } from './context.js';
import * as repo from './trackers.repository.js';
import { bmiClass, bucketLabel, chartBuckets, weightProgress, yAxis } from './trackers.rules.js';

/** Geçmişe dönük kilo kaydı sınırı (eski tartıları girmek için geniş). */
const WEIGHT_PAST_DAYS = 365;

const toDto = (e) => ({
  id: e.id,
  weightKg: e.weightKg,
  recordedAt: e.recordedAt.toISOString(),
  localDate: e.localDate,
  source: e.source,
});

/**
 * Kilo kayıtları, grafik ve özet (docs/backend/04-api.md §7, 05 §9). Hedef kilo profildedir;
 * `PATCH /weights/goal` profil güncellemesine gider (aynı doğrulamalar).
 */
export function createWeightsService({ db, ctx, users }) {
  async function mustFind(userId, id, conn) {
    const e = await repo.findWeight(db, userId, id, conn);
    if (!e || e.foreign) throw new AppError('NOT_FOUND');
    return e;
  }

  const service = {
    async create(userId, body) {
      const now = new Date();
      const recordedAt = body.recordedAt ? new Date(body.recordedAt) : now;
      assertInstant(recordedAt, now, { path: 'recordedAt', pastDays: WEIGHT_PAST_DAYS });
      return ctx.write(userId, async (conn, { tz, touch }) => {
        if (body.id) {
          const existing = await repo.findWeight(db, userId, body.id, conn, {
            includeDeleted: true,
          });
          if (existing?.foreign)
            throw new AppError('CONFLICT', { details: { reason: 'id_taken' } });
          if (existing) return { created: false, entry: toDto(existing) };
        }
        const entry = {
          id: body.id ?? newId(),
          weightKg: body.weightKg,
          recordedAt,
          localDate: localDate(recordedAt, tz),
          tz,
          source: 'manual',
        };
        await repo.insertWeight(db, conn, userId, entry);
        touch(entry.localDate);
        return { created: true, entry: toDto(entry) };
      });
    },

    async update(userId, id, body) {
      const now = new Date();
      return ctx.write(userId, async (conn, { tz, touch }) => {
        const e = await mustFind(userId, id, conn);
        const recordedAt = body.recordedAt ? new Date(body.recordedAt) : e.recordedAt;
        if (body.recordedAt) {
          assertInstant(recordedAt, now, { path: 'recordedAt', pastDays: WEIGHT_PAST_DAYS });
        }
        const next = {
          weightKg: body.weightKg ?? e.weightKg,
          recordedAt,
          localDate: body.recordedAt ? localDate(recordedAt, tz) : e.localDate,
        };
        await repo.updateWeight(db, conn, id, next);
        touch(e.localDate);
        touch(next.localDate);
        return { entry: toDto({ ...e, ...next }) };
      });
    },

    async remove(userId, id) {
      await ctx.write(userId, async (conn, { touch }) => {
        const e = await mustFind(userId, id, conn);
        await repo.softDeleteWeight(db, conn, id);
        touch(e.localDate);
      });
      return {};
    },

    async list(userId, { from, to, cursor, limit = 20 }) {
      const after = decodeCursor(cursor, ['t', 'i']);
      const rows = await repo.listWeights(db, userId, {
        from,
        to,
        before: after ? { at: new Date(after.t), id: after.i } : null,
        limit,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const hasMore = rows.length > limit;
      return {
        items: page.map(toDto),
        pageInfo: {
          nextCursor:
            hasMore && last ? encodeCursor({ t: last.recordedAt.toISOString(), i: last.id }) : null,
          hasMore,
        },
      };
    },

    /** 7 kova; her kovada son ölçüm. Ölçüm olmayan kova null (istemci çizgiyi atlar). */
    async chart(userId, range, locale) {
      const { today } = await ctx.zone(userId);
      const buckets = chartBuckets(range, today);
      const entries = await repo.weightsBetween(db, userId, {
        from: buckets[0].from,
        to: buckets.at(-1).to,
      });
      const profile = await userRepo.getProfile(db, userId);
      const goalKg = profile?.goal_weight_kg ?? null;
      const items = buckets.map((b) => {
        const inBucket = entries.filter((e) => e.localDate >= b.from && e.localDate <= b.to);
        return {
          label: bucketLabel(range, b, locale),
          from: b.from,
          to: b.to,
          weightKg: inBucket.at(-1)?.weightKg ?? null,
        };
      });
      // Hedef çizgisi de görünsün diye eksen hedefi kapsar.
      const axis = yAxis([...items.map((i) => i.weightKg), goalKg]);
      return { range, buckets: items, yAxis: axis, goalKg };
    },

    async summary(userId) {
      const { today } = await ctx.zone(userId);
      const profile = await userRepo.getProfile(db, userId);
      const startKg = profile?.start_weight_kg ?? null;
      const currentKg = profile?.current_weight_kg ?? startKg;
      const goalKg = profile?.goal_weight_kg ?? null;
      const heightCm = profile?.height_cm ?? null;
      const value = currentKg && heightCm ? bmi(currentKg, heightCm) : null;
      return {
        currentKg,
        startKg,
        goalKg,
        progress: weightProgress(startKg, currentKg, goalKg),
        changeKg:
          currentKg !== null && startKg !== null
            ? Math.round((currentKg - startKg) * 100) / 100
            : null,
        bmi: value,
        ...bmiClass(value),
        heightCm,
        targetDate:
          currentKg && goalKg
            ? projection({
                currentKg,
                goalKg,
                weeklyLossKg: profile?.weekly_loss_target_kg ?? DEFAULT_WEEKLY_LOSS_KG,
                todayIso: today,
              }).targetDate
            : null,
      };
    },

    async setGoal(userId, goalWeightKg, meta) {
      const result = await users.updateProfile(userId, { goalWeightKg }, meta);
      return { ...(await service.summary(userId)), warnings: result.warnings ?? [] };
    },
  };
  return service;
}
