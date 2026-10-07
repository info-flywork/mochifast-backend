import { AppError } from '../../shared/errors.js';
import { toApiEnum, toDbEnum } from '../../shared/enums.js';
import { newId } from '../../shared/ids.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination.js';
import { addDays, localDate } from '../../shared/time.js';
import * as fastingRepo from '../fasting/fasting.repository.js';
import { assertInstant } from '../trackers/context.js';
import * as trackersRepo from '../trackers/trackers.repository.js';
import * as repo from './hunger.repository.js';
import { recommendationCodes, scoreHunger } from './hunger.rules.js';

const HUNGER_PAST_DAYS = 7;
const NOTE_CONTEXT = (id) => `hunger_checkins.notes:${id}`;

/**
 * Açlık check-in'leri (docs/backend/04-api.md §12, 05 §5). Sonuç her zaman sunucuda, o anki
 * aktif oruç bağlamıyla hesaplanır; istemcinin gönderdiği sonuç kullanılmaz.
 */
export function createHungerService({ db, crypto, ctx, content }) {
  /** `at` anında aktif olan oruç: bağlam puanı ve güvenlik bayrağı için. */
  async function fastContext(userId, at, conn) {
    const active = await fastingRepo.findActive(db, userId, conn);
    if (!active || active.startedAt > at) return null;
    return {
      fastId: active.id,
      fastedMinutes: Math.floor((at.getTime() - active.startedAt.getTime()) / 60_000),
      targetMinutes: active.targetMinutes,
    };
  }

  async function withTexts(result, locale, fast) {
    const texts = await content.hungerRecommendations(locale);
    return {
      resultType: result.resultType,
      physicalScore: result.physicalScore,
      emotionalScore: result.emotionalScore,
      safetyFlag: result.safetyFlag,
      scoringVersion: result.scoringVersion,
      // Güvenlik bayrağında istemci "Orucu bitir" kısayolunu bu oruca bağlar.
      activeFastId: fast?.fastId ?? null,
      recommendations: result.recommendationCodes.map((code) => ({
        code,
        title: texts[code] ?? code,
      })),
    };
  }

  function toDto(c) {
    return {
      id: c.id,
      loggedAt: c.loggedAt.toISOString(),
      localDate: c.localDate,
      mode: toApiEnum(c.mode),
      symptoms: c.symptoms.map(toApiEnum),
      q1: toApiEnum(c.q1),
      q2: toApiEnum(c.q2),
      bodyNotices: c.bodyNotices.map(toApiEnum),
      q4: toApiEnum(c.q4),
      physicalScore: c.physicalScore,
      emotionalScore: c.emotionalScore,
      resultType: c.resultType,
      safetyFlag: c.safetyFlag,
      scoringVersion: c.scoringVersion,
      notes: c.notesEnc ? crypto.decrypt(c.notesEnc, NOTE_CONTEXT(c.id)) : null,
      fastId: c.fastId,
      fastedMinutes: c.fastedMinutes,
    };
  }

  const service = {
    /** Durumsuz skorlama (sonuç ekranı). */
    async evaluate(userId, body, locale) {
      const fast = await fastContext(userId, new Date());
      return withTexts(scoreHunger(body, fast), locale, fast);
    },

    async create(userId, body, locale) {
      const now = new Date();
      const loggedAt = body.loggedAt ? new Date(body.loggedAt) : now;
      assertInstant(loggedAt, now, { path: 'loggedAt', pastDays: HUNGER_PAST_DAYS });
      const saved = await ctx.write(userId, async (conn, { tz, touch }) => {
        if (body.id) {
          const existing = await repo.findCheckin(db, userId, body.id, conn, {
            includeDeleted: true,
          });
          if (existing?.foreign)
            throw new AppError('CONFLICT', { details: { reason: 'id_taken' } });
          if (existing) return { created: false, checkin: existing, fast: null };
        }
        const fast = await fastContext(userId, loggedAt, conn);
        const result = scoreHunger(body, fast);
        const id = body.id ?? newId();
        const checkin = {
          id,
          loggedAt,
          localDate: localDate(loggedAt, tz),
          tz,
          mode: toDbEnum(body.mode),
          symptoms: (body.symptoms ?? []).map(toDbEnum),
          q1: toDbEnum(body.q1 ?? null),
          q2: toDbEnum(body.q2 ?? null),
          bodyNotices: (body.bodyNotices ?? []).map(toDbEnum),
          q4: toDbEnum(body.q4 ?? null),
          ...result,
          notesEnc: body.notes ? crypto.encrypt(body.notes, NOTE_CONTEXT(id)) : null,
          fastId: fast?.fastId ?? null,
          fastedMinutes: fast?.fastedMinutes ?? null,
        };
        await repo.insertCheckin(db, conn, userId, checkin);
        touch(checkin.localDate);
        return { created: true, checkin: await repo.findCheckin(db, userId, id, conn), fast };
      });
      // Sonuç saklanan değerlerden döner: tekrar gönderim yeniden puanlanmaz.
      const c = saved.checkin;
      const evaluation = await withTexts(
        { ...c, recommendationCodes: recommendationCodes(c.resultType, c.safetyFlag) },
        locale,
        saved.fast,
      );
      return { created: saved.created, checkin: toDto(c), ...evaluation };
    },

    async remove(userId, id) {
      await ctx.write(userId, async (conn, { touch }) => {
        const c = await repo.findCheckin(db, userId, id, conn);
        if (!c || c.foreign) throw new AppError('NOT_FOUND');
        await repo.softDeleteCheckin(db, conn, id);
        touch(c.localDate);
      });
      return {};
    },

    async list(userId, { date, type = 'all', cursor, limit = 20 }) {
      const after = decodeCursor(cursor, ['t', 'i']);
      const rows = await repo.listCheckins(db, userId, {
        date,
        type: type === 'all' ? null : type,
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
            hasMore && last ? encodeCursor({ t: last.loggedAt.toISOString(), i: last.id }) : null,
          hasMore,
        },
      };
    },

    /** Bugünün sayıları ve son 7 gün (oruç dakikasıyla birlikte; Insights grafiği). */
    async summary(userId, date) {
      const { today } = await ctx.zone(userId);
      const day = date ?? today;
      const from = addDays(day, -6);
      const summaries = await trackersRepo.summariesBetween(db, userId, { from, to: day });
      const week = [];
      for (let d = from; d <= day; d = addDays(d, 1)) {
        const s = summaries.get(d);
        week.push({
          date: d,
          physical: s?.hunger_physical ?? 0,
          emotional: s?.hunger_emotional ?? 0,
          fastedMinutes: s?.fasted_minutes ?? 0,
        });
      }
      const t = week.at(-1);
      return {
        today: {
          date: day,
          total: t.physical + t.emotional,
          physical: t.physical,
          emotional: t.emotional,
        },
        week,
      };
    },
  };
  return service;
}
