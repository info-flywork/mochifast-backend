import { DateTime } from 'luxon';
import { AppError } from '../../shared/errors.js';
import { toApiEnum, toDbEnum } from '../../shared/enums.js';
import { newId } from '../../shared/ids.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination.js';
import { addDays, localDate, mondayOf } from '../../shared/time.js';
import * as fastingRepo from '../fasting/fasting.repository.js';
import { assertInstant } from '../trackers/context.js';
import * as trackersRepo from '../trackers/trackers.repository.js';
import { stepKcal } from '../trackers/trackers.rules.js';
import * as userRepo from '../user/user.repository.js';
import { burnedKcal, computeNutritionGoals, nutritionInputs } from '../user/nutrition.rules.js';
import * as repo from './meals.repository.js';

const MEAL_PAST_DAYS = 30;
const NOTE_CONTEXT = (id) => `meals.notes:${id}`;
const ENUM_FIELDS = ['kind', 'slot', 'dietType', 'feeling'];

const round1 = (v) => Math.round(v * 10) / 10;
const ratio = (a, b) => (b ? Math.min(1, Math.round((a / b) * 1000) / 1000) : null);

/**
 * Öğünler ve beslenme (docs/backend/04-api.md §11, 05 §6). Fotoğraf `POST /v1/media` ile
 * yüklenip `photoMediaId` ile bağlanır; AI analizi F6'da (`source: aiPhoto`).
 */
export function createMealsService({ db, crypto, ctx, media, analyses }) {
  function toDto(m, photos = new Map()) {
    return {
      id: m.id,
      eatenAt: m.eatenAt.toISOString(),
      localDate: m.localDate,
      kind: toApiEnum(m.kind),
      slot: toApiEnum(m.slot),
      dietType: toApiEnum(m.dietType),
      feeling: toApiEnum(m.feeling),
      title: m.title,
      notes: m.notesEnc ? crypto.decrypt(m.notesEnc, NOTE_CONTEXT(m.id)) : null,
      kcal: m.kcal,
      proteinG: m.proteinG,
      carbsG: m.carbsG,
      fatG: m.fatG,
      source: toApiEnum(m.source),
      breaksFastId: m.breaksFastId,
      photo: (m.photoMediaId && photos.get(m.photoMediaId)) ?? null,
    };
  }

  /** Öğünleri fotoğraflarıyla (imzalı URL) birlikte, tek medya sorgusuyla sunar. */
  async function toDtos(meals) {
    const photos = await media.presentMany(meals.map((m) => m.photoMediaId));
    return meals.map((m) => toDto(m, photos));
  }
  const one = async (m) => (await toDtos([m]))[0];

  /**
   * Fotoğraf kullanıcının kendi, hazır öğün fotoğrafı olmalı (null → bağlantı kalkar).
   * `analysisId` verilirse fotoğraf analizden gelir ve kaynak `ai_photo` olur.
   */
  async function photoField(userId, body) {
    if (body.analysisId) {
      const a = await analyses.mustUse(userId, body.analysisId);
      return { photoMediaId: a.mediaId, analysisId: a.id };
    }
    if (body.photoMediaId === undefined) return {};
    if (body.photoMediaId === null) return { photoMediaId: null };
    await media.mustOwn(userId, body.photoMediaId, { purpose: 'meal_photo' });
    return { photoMediaId: body.photoMediaId };
  }

  function encryptNotes(id, notes) {
    if (notes === undefined) return undefined;
    return notes === null || notes === '' ? null : crypto.encrypt(notes, NOTE_CONTEXT(id));
  }

  function dbFields(body) {
    const out = {};
    for (const k of ENUM_FIELDS) if (body[k] !== undefined) out[k] = toDbEnum(body[k]);
    for (const k of ['title', 'kcal', 'proteinG', 'carbsG', 'fatG']) {
      if (body[k] !== undefined) out[k] = body[k];
    }
    return out;
  }

  async function mustFind(userId, id, conn) {
    const m = await repo.findMeal(db, userId, id, conn);
    if (!m || m.foreign) throw new AppError('NOT_FOUND');
    return m;
  }

  /** Günün hedefleri: kullanıcının elle girdiği, yoksa öneri (adım kalorisi dahil). */
  async function dayGoals(userId, date) {
    const [profile, goals, steps] = await Promise.all([
      userRepo.getProfile(db, userId),
      userRepo.getGoals(db, userId),
      trackersRepo.findSteps(db, userId, date),
    ]);
    const inputs = nutritionInputs(profile, date);
    const stepsKcal = stepKcal(steps, inputs);
    const computed = computeNutritionGoals({ ...inputs, stepKcal: stepsKcal });
    // Yeme bozukluğu geçmişinde hedef hiç gösterilmez; elle girilmiş olsa bile (05 §6.3).
    const hidden = (inputs.healthFlags ?? []).includes('eating_disorder_history');
    const pick = (own, suggested) => (hidden ? null : (own ?? suggested));
    return {
      inputs,
      stepsKcal,
      kcalGoal: pick(goals?.kcal_goal, computed.kcalGoal),
      proteinGoalG: pick(goals?.protein_goal_g, computed.proteinGoalG),
      carbsGoalG: pick(goals?.carbs_goal_g, computed.carbsGoalG),
      fatGoalG: pick(goals?.fat_goal_g, computed.fatGoalG),
    };
  }

  const service = {
    /** POST /v1/meals — aktif oruç varsa "orucu bitir?" önerisi döner. */
    async create(userId, body) {
      const now = new Date();
      const eatenAt = body.eatenAt ? new Date(body.eatenAt) : now;
      assertInstant(eatenAt, now, { path: 'eatenAt', pastDays: MEAL_PAST_DAYS });
      const photo = await photoField(userId, body);
      const result = await ctx.write(userId, async (conn, { tz, touch }) => {
        if (body.id) {
          const existing = await repo.findMeal(db, userId, body.id, conn, { includeDeleted: true });
          if (existing?.foreign)
            throw new AppError('CONFLICT', { details: { reason: 'id_taken' } });
          if (existing) return { created: false, meal: existing };
        }
        const id = body.id ?? newId();
        const meal = {
          id,
          eatenAt,
          localDate: localDate(eatenAt, tz),
          tz,
          ...dbFields(body),
          ...photo,
          notesEnc: encryptNotes(id, body.notes) ?? null,
          source: toDbEnum(body.source ?? (photo.analysisId ? 'aiPhoto' : 'manual')),
        };
        await repo.insertMeal(db, conn, userId, meal);
        touch(meal.localDate);
        return { created: true, meal: await repo.findMeal(db, userId, id, conn) };
      });
      const active = await fastingRepo.findActive(db, userId);
      const breaksFast = Boolean(active && result.meal.eatenAt >= active.startedAt);
      return {
        created: result.created,
        meal: await one(result.meal),
        activeFastId: breaksFast ? active.id : null,
        suggestEndFast: breaksFast,
      };
    },

    async get(userId, id) {
      return { meal: await one(await mustFind(userId, id)) };
    },

    async update(userId, id, body) {
      const now = new Date();
      const photo = await photoField(userId, body);
      const meal = await ctx.write(userId, async (conn, { tz, touch }) => {
        const m = await mustFind(userId, id, conn);
        const fields = { ...dbFields(body), ...photo };
        if (body.eatenAt) {
          const eatenAt = new Date(body.eatenAt);
          assertInstant(eatenAt, now, { path: 'eatenAt', pastDays: MEAL_PAST_DAYS });
          fields.eatenAt = eatenAt;
          fields.localDate = localDate(eatenAt, tz);
        }
        if (body.notes !== undefined) fields.notesEnc = encryptNotes(id, body.notes);
        await repo.updateMeal(db, conn, id, fields);
        touch(m.localDate);
        if (fields.localDate) touch(fields.localDate);
        return repo.findMeal(db, userId, id, conn);
      });
      return { meal: await one(meal) };
    },

    async remove(userId, id) {
      await ctx.write(userId, async (conn, { touch }) => {
        const m = await mustFind(userId, id, conn);
        await repo.softDeleteMeal(db, conn, id);
        touch(m.localDate);
      });
      return {};
    },

    /** `date` verilirse o günün zaman çizelgesi (eskiden yeniye), yoksa sayfalı geçmiş. */
    async list(userId, { date, from, to, cursor, limit = 20 }) {
      if (date) {
        const items = await repo.mealsOfDay(db, userId, date);
        return { items: await toDtos(items), pageInfo: { nextCursor: null, hasMore: false } };
      }
      const after = decodeCursor(cursor, ['t', 'i']);
      const rows = await repo.listMeals(db, userId, {
        from,
        to,
        before: after ? { at: new Date(after.t), id: after.i } : null,
        limit,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const hasMore = rows.length > limit;
      return {
        items: await toDtos(page),
        pageInfo: {
          nextCursor:
            hasMore && last ? encodeCursor({ t: last.eatenAt.toISOString(), i: last.id }) : null,
          hasMore,
        },
      };
    },

    /** GET /v1/nutrition/day — Calories ve Protein Tracker ekranları. */
    async day(userId, date) {
      const { tz, today } = await ctx.zone(userId);
      const day = date ?? today;
      const [meals, goals] = await Promise.all([
        repo.mealsOfDay(db, userId, day),
        dayGoals(userId, day),
      ]);
      const sum = (k) => round1(meals.reduce((a, m) => a + (m[k] ?? 0), 0));
      const kcal = Math.round(sum('kcal'));
      // Yakılan kalori: bugün için günün geçen kısmı, geçmiş gün tam gün, gelecek gün 0.
      const local = DateTime.now().setZone(tz);
      let elapsed = 1440;
      if (day === today) elapsed = local.hour * 60 + local.minute;
      else if (day > today) elapsed = 0;
      const macro = (g, goalG) => ({ g, goalG, progress: ratio(g, goalG) });
      return {
        date: day,
        kcal,
        kcalGoal: goals.kcalGoal,
        progress: ratio(kcal, goals.kcalGoal),
        overKcal: goals.kcalGoal === null ? null : Math.max(0, kcal - goals.kcalGoal),
        burnedKcal: burnedKcal(goals.inputs, {
          elapsedMinutes: elapsed,
          stepKcal: goals.stepsKcal,
        }),
        macros: {
          protein: macro(sum('proteinG'), goals.proteinGoalG),
          carbs: macro(sum('carbsG'), goals.carbsGoalG),
          fat: macro(sum('fatG'), goals.fatGoalG),
        },
        meals: await toDtos(meals),
      };
    },

    /** GET /v1/nutrition/week — Pzt–Paz çubuk grafik (kcal ya da protein). */
    async week(userId, { date, metric = 'kcal' }) {
      const { today } = await ctx.zone(userId);
      const from = mondayOf(date ?? today);
      const to = addDays(from, 6);
      const [summaries, goals] = await Promise.all([
        trackersRepo.summariesBetween(db, userId, { from, to }),
        dayGoals(userId, today),
      ]);
      const goal = metric === 'protein' ? goals.proteinGoalG : goals.kcalGoal;
      const days = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const s = summaries.get(d);
        const value = metric === 'protein' ? Number(s?.protein_g ?? 0) : (s?.kcal ?? 0);
        days.push({
          date: d,
          value,
          progress: ratio(value, goal),
          isToday: d === today,
          isFuture: d > today,
        });
      }
      return { metric, weekStart: from, goal, days };
    },
  };
  return service;
}
