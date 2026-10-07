import { AppError } from '../../shared/errors.js';
import { toApiEnum, toDbEnum } from '../../shared/enums.js';
import { newId, toBin } from '../../shared/ids.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination.js';
import { isValidTimezone, localDate } from '../../shared/time.js';
import { writeAudit } from '../audit/audit.repository.js';
import * as userRepo from '../user/user.repository.js';
import * as repo from './fasting.repository.js';
import {
  MANUAL_PAST_LIMIT_MS,
  assertStartWindow,
  assertTarget,
  bodyStage,
  cancelDeletes,
  eatingStage,
  finishOutcome,
  plannedEnd,
  progressOf,
} from './fasting.rules.js';

const ER_DUP_ENTRY = 1062;
const NOTE_CONTEXT = (id) => `fasting_sessions.notes:${id}`;

/**
 * Oruç seansları (docs/backend/04-api.md §6, 05 §1). Her yazma işlemi kullanıcı satırını
 * kilitler: aynı kullanıcının eşzamanlı istekleri sırayla işlenir (tek aktif oruç, çakışma).
 */
export function createFastingService({ db, crypto, plans, content }) {
  async function context(userId, conn, { lock = false } = {}) {
    if (lock)
      await db.one('SELECT id FROM users WHERE id = :id FOR UPDATE', { id: toBin(userId) }, conn);
    const user = await userRepo.getUserWithUnits(db, userId, conn);
    if (!user) throw new AppError('NOT_FOUND');
    return { tz: isValidTimezone(user.timezone) ? user.timezone : 'UTC' };
  }

  async function mustFind(userId, id, conn, options) {
    const s = await repo.findById(db, userId, id, conn, options);
    if (!s || s.foreign) throw new AppError('NOT_FOUND');
    return s;
  }

  async function assertNoOverlap(conn, userId, start, end, excludeId) {
    const clash = await repo.findOverlapping(db, conn, userId, start, end, excludeId);
    if (clash.length > 0) {
      throw new AppError('FAST_OVERLAP', { details: { fastIds: clash.map((c) => c.id) } });
    }
  }

  function encryptNotes(id, notes) {
    if (notes === undefined) return undefined;
    return notes === null || notes === '' ? null : crypto.encrypt(notes, NOTE_CONTEXT(id));
  }

  function toDto(s, { now = new Date(), stages = null, withNotes = false } = {}) {
    const base = {
      id: s.id,
      status: toApiEnum(s.status),
      planCode: s.planCode,
      targetMinutes: s.targetMinutes,
      startedAt: s.startedAt.toISOString(),
      plannedEndAt: s.plannedEndAt.toISOString(),
      endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      durationMinutes: s.durationMinutes,
      goalReached: s.goalReached,
      localDate: s.endLocalDate ?? s.startLocalDate,
      tz: s.tz,
      feeling: s.feeling,
      source: toApiEnum(s.source),
      autoClosed: s.autoClosed,
    };
    if (withNotes) {
      base.notes = s.notesEnc ? crypto.decrypt(s.notesEnc, NOTE_CONTEXT(s.id)) : null;
    }
    if (s.status === 'active') {
      const elapsed = Math.max(0, Math.floor((now.getTime() - s.startedAt.getTime()) / 60_000));
      const stage = stages ? bodyStage(elapsed, stages, s.startedAt) : null;
      Object.assign(base, {
        elapsedMinutes: elapsed,
        progress: progressOf(elapsed, s.targetMinutes),
        goalReached: elapsed >= s.targetMinutes,
        stage: stage && { ...stage, nextStageAt: stage.nextStageAt?.toISOString() ?? null },
        serverTime: now.toISOString(),
      });
    }
    return base;
  }

  /** Son biten orucun ardındaki yeme penceresi (aktif oruç yokken). */
  async function eatingWindow(userId, now, locale) {
    const last = await repo.lastFinished(db, userId);
    if (!last?.endedAt) return null;
    const current = await plans.findCurrent(userId);
    const eatMinutes = Math.max(60, 1440 - (current?.fastMinutes ?? last.targetMinutes));
    const since = Math.floor((now.getTime() - last.endedAt.getTime()) / 60_000);
    const stageKey = eatingStage(since, eatMinutes);
    if (!stageKey) return null;
    const stages = (await content.stages('eating_window', locale)).items;
    const stage = stages.find((s) => s.imageKey === stageKey);
    const endsAt = new Date(last.endedAt.getTime() + eatMinutes * 60_000);
    return {
      lastFastId: last.id,
      startedAt: last.endedAt.toISOString(),
      endsAt: endsAt.toISOString(),
      eatMinutes,
      elapsedMinutes: since,
      stage: stage
        ? { key: stageKey, title: stage.title, position: stage.position }
        : { key: stageKey },
      suggestedNextStartAt: endsAt.toISOString(),
      serverTime: now.toISOString(),
    };
  }

  const service = {
    /** GET /v1/fasts/active */
    async active(userId, locale) {
      const now = new Date();
      const s = await repo.findActive(db, userId);
      if (!s) return { fast: null, eatingWindow: await eatingWindow(userId, now, locale) };
      const stages = (await content.stages('body', locale)).items;
      return { fast: toDto(s, { now, stages }), eatingWindow: null };
    },

    /** POST /v1/fasts — başlat. İstemci `id` verirse tekrar gönderim aynı seansı döner. */
    async start(userId, body, meta, locale) {
      const now = new Date();
      const startedAt = body.startedAt ? new Date(body.startedAt) : now;
      assertStartWindow(startedAt, now);

      try {
        const result = await db.withTransaction(async (conn) => {
          const { tz } = await context(userId, conn, { lock: true });
          if (body.id) {
            const existing = await repo.findById(db, userId, body.id, conn, {
              includeDeleted: true,
            });
            if (existing?.foreign)
              throw new AppError('CONFLICT', { details: { reason: 'id_taken' } });
            if (existing) return { session: existing, replay: true };
          }
          const active = await repo.findActive(db, userId, conn, { forUpdate: true });
          if (active) {
            throw new AppError('ACTIVE_FAST_EXISTS', { details: { activeFastId: active.id } });
          }
          const startLocal = localDate(startedAt, tz);
          const target = await plans.targetFor(userId, startLocal, conn);
          const targetMinutes = body.targetMinutes ?? target.fastMinutes;
          assertTarget(targetMinutes);
          const end = plannedEnd(startedAt, targetMinutes);
          await assertNoOverlap(conn, userId, startedAt, end);

          const session = {
            id: body.id ?? newId(),
            userId,
            userPlanId: target.userPlan?.id ?? null,
            planCode: target.userPlan?.planCode ?? null,
            targetMinutes,
            status: 'active',
            startedAt,
            plannedEndAt: end,
            startLocalDate: startLocal,
            tz,
            source: body.source ? toDbEnum(body.source) : 'app',
          };
          await repo.insert(db, conn, session);
          await writeAudit(db, auditEntry(userId, 'fast.started', session.id, meta), conn);
          return { session: await repo.findById(db, userId, session.id, conn), replay: false };
        });
        const stages = (await content.stages('body', locale)).items;
        return { created: !result.replay, fast: toDto(result.session, { stages }) };
      } catch (err) {
        // Eşzamanlı ikinci başlatma tek-aktif kısıtına takılır.
        if (err?.errno === ER_DUP_ENTRY) {
          const active = await repo.findActive(db, userId);
          throw new AppError('ACTIVE_FAST_EXISTS', {
            details: { activeFastId: active?.id ?? null },
          });
        }
        throw err;
      }
    },

    /** POST /v1/fasts/:id/finish */
    async finish(userId, id, body, meta) {
      const now = new Date();
      const result = await db.withTransaction(async (conn) => {
        const { tz } = await context(userId, conn, { lock: true });
        const s = await mustFind(userId, id, conn, { forUpdate: true });
        if (s.status !== 'active')
          throw new AppError('CONFLICT', {
            details: { reason: 'not_active', status: toApiEnum(s.status) },
          });

        const startedAt = body.startedAt ? new Date(body.startedAt) : s.startedAt;
        if (body.startedAt) assertStartWindow(startedAt, now);
        const endedAt = body.endedAt ? new Date(body.endedAt) : now;
        const outcome = finishOutcome({ startedAt, endedAt, targetMinutes: s.targetMinutes, now });
        // Planlanandan geç bitirilen oruç, araya elle kaydedilmiş bir oruçla çakışabilir.
        await assertNoOverlap(conn, userId, startedAt, endedAt, s.id);

        const endLocalDate = localDate(endedAt, s.tz ?? tz);
        let weightEntryId;
        if (body.weightKg !== undefined) {
          weightEntryId = newId();
          await db.run(
            `INSERT INTO weight_entries (id, user_id, weight_kg, recorded_at, local_date, tz, source)
             VALUES (:id, :userId, :weightKg, :recordedAt, :localDate, :tz, 'fasting_finish')`,
            {
              id: toBin(weightEntryId),
              userId: toBin(userId),
              weightKg: body.weightKg,
              recordedAt: endedAt,
              localDate: endLocalDate,
              tz: s.tz,
            },
            conn,
          );
        }
        await repo.update(db, conn, s.id, {
          status: outcome.status,
          startedAt,
          plannedEndAt: plannedEnd(startedAt, s.targetMinutes),
          startLocalDate: localDate(startedAt, s.tz),
          endedAt,
          durationMinutes: outcome.durationMinutes,
          goalReached: outcome.goalReached,
          endLocalDate,
          feeling: body.feeling ?? null,
          notesEnc: encryptNotes(s.id, body.notes) ?? null,
          ...(weightEntryId ? { weightEntryId } : {}),
        });

        // İlk tamamlanan oruç (kutlama ekranı).
        let isFirstFast = false;
        if (outcome.status === 'completed') {
          await userRepo.ensureDefaults(db, conn, userId);
          const r = await db.run(
            `UPDATE user_stats SET first_fast_completed_at = :at
              WHERE user_id = :userId AND first_fast_completed_at IS NULL`,
            { at: endedAt, userId: toBin(userId) },
            conn,
          );
          isFirstFast = r.affectedRows === 1;
        }
        await writeAudit(
          db,
          auditEntry(userId, 'fast.finished', s.id, meta, { status: outcome.status }),
          conn,
        );
        return { session: await repo.findById(db, userId, s.id, conn), outcome, isFirstFast };
      });
      return {
        fast: toDto(result.session, { withNotes: true }),
        isFirstFast: result.isFirstFast,
        warnings: result.outcome.warnings,
      };
    },

    /** POST /v1/fasts/:id/cancel — 10 dk içinde iz bırakmaz, sonra 'cancelled'. */
    async cancel(userId, id, meta) {
      const now = new Date();
      return db.withTransaction(async (conn) => {
        await context(userId, conn, { lock: true });
        const s = await mustFind(userId, id, conn, { forUpdate: true });
        if (s.status !== 'active')
          throw new AppError('CONFLICT', { details: { reason: 'not_active' } });
        if (cancelDeletes(s.startedAt, now)) {
          await repo.hardDelete(db, conn, s.id);
          return { id: s.id, deleted: true };
        }
        await repo.update(db, conn, s.id, { status: 'cancelled', endedAt: now });
        await writeAudit(db, auditEntry(userId, 'fast.cancelled', s.id, meta), conn);
        return { id: s.id, deleted: false };
      });
    },

    /** PATCH /v1/fasts/:id — aktifte başlangıç/hedef; bitmişte zamanlar, his, not. */
    async update(userId, id, body, meta) {
      const now = new Date();
      const session = await db.withTransaction(async (conn) => {
        await context(userId, conn, { lock: true });
        const s = await mustFind(userId, id, conn, { forUpdate: true });
        if (s.status === 'cancelled')
          throw new AppError('CONFLICT', { details: { reason: 'cancelled' } });
        const startedAt = body.startedAt ? new Date(body.startedAt) : s.startedAt;
        const targetMinutes = body.targetMinutes ?? s.targetMinutes;
        assertTarget(targetMinutes);
        if (body.startedAt) {
          assertStartWindow(startedAt, now, {
            pastLimitMs: s.status === 'active' ? undefined : MANUAL_PAST_LIMIT_MS,
          });
        }

        if (s.status === 'active') {
          if (body.endedAt !== undefined) {
            throw new AppError('VALIDATION_FAILED', {
              details: { fields: [{ path: 'endedAt', message: 'use POST /fasts/:id/finish' }] },
            });
          }
          const end = plannedEnd(startedAt, targetMinutes);
          await assertNoOverlap(conn, userId, startedAt, end, s.id);
          await repo.update(db, conn, s.id, {
            startedAt,
            targetMinutes,
            plannedEndAt: end,
            startLocalDate: localDate(startedAt, s.tz),
          });
        } else {
          const endedAt = body.endedAt ? new Date(body.endedAt) : s.endedAt;
          const outcome = finishOutcome({ startedAt, endedAt, targetMinutes, now });
          await assertNoOverlap(conn, userId, startedAt, endedAt, s.id);
          await repo.update(db, conn, s.id, {
            startedAt,
            targetMinutes,
            plannedEndAt: plannedEnd(startedAt, targetMinutes),
            startLocalDate: localDate(startedAt, s.tz),
            endedAt,
            durationMinutes: outcome.durationMinutes,
            goalReached: outcome.goalReached,
            status: outcome.status,
            endLocalDate: localDate(endedAt, s.tz),
            ...(body.feeling !== undefined ? { feeling: body.feeling } : {}),
            ...(body.notes !== undefined ? { notesEnc: encryptNotes(s.id, body.notes) } : {}),
          });
        }
        await writeAudit(db, auditEntry(userId, 'fast.updated', s.id, meta), conn);
        return repo.findById(db, userId, s.id, conn);
      });
      return { fast: toDto(session, { withNotes: true }) };
    },

    /** POST /v1/fasts/manual — geçmiş oruç kaydı. */
    async manual(userId, body, meta) {
      const now = new Date();
      const startedAt = new Date(body.startedAt);
      const endedAt = new Date(body.endedAt);
      assertStartWindow(startedAt, now, { pastLimitMs: MANUAL_PAST_LIMIT_MS });
      const session = await db.withTransaction(async (conn) => {
        const { tz } = await context(userId, conn, { lock: true });
        const startLocal = localDate(startedAt, tz);
        const target = await plans.targetFor(userId, startLocal, conn);
        const targetMinutes = body.targetMinutes ?? target.fastMinutes;
        assertTarget(targetMinutes);
        const outcome = finishOutcome({ startedAt, endedAt, targetMinutes, now });
        await assertNoOverlap(conn, userId, startedAt, endedAt);
        const id = newId();
        await repo.insert(db, conn, {
          id,
          userId,
          userPlanId: target.userPlan?.id ?? null,
          planCode: target.userPlan?.planCode ?? null,
          targetMinutes,
          status: outcome.status,
          startedAt,
          plannedEndAt: plannedEnd(startedAt, targetMinutes),
          endedAt,
          durationMinutes: outcome.durationMinutes,
          goalReached: outcome.goalReached,
          startLocalDate: startLocal,
          endLocalDate: localDate(endedAt, tz),
          tz,
          feeling: body.feeling ?? null,
          notesEnc: encryptNotes(id, body.notes) ?? null,
          source: 'manual_log',
        });
        await writeAudit(db, auditEntry(userId, 'fast.logged', id, meta), conn);
        return repo.findById(db, userId, id, conn);
      });
      return { fast: toDto(session, { withNotes: true }) };
    },

    /** DELETE /v1/fasts/:id — yumuşak silme (aktif oruç iptal edilmeli). */
    async remove(userId, id, meta) {
      await db.withTransaction(async (conn) => {
        await context(userId, conn, { lock: true });
        const s = await mustFind(userId, id, conn, { forUpdate: true });
        if (s.status === 'active')
          throw new AppError('CONFLICT', { details: { reason: 'active_use_cancel' } });
        await repo.softDelete(db, conn, s.id);
        await writeAudit(db, auditEntry(userId, 'fast.deleted', s.id, meta), conn);
      });
      return {};
    },

    async get(userId, id) {
      return { fast: toDto(await mustFind(userId, id), { withNotes: true }) };
    },

    async list(userId, { from, to, status, cursor, limit = 20 }) {
      const after = decodeCursor(cursor, ['t', 'i']);
      const rows = await repo.list(db, userId, {
        from,
        to,
        status: status ? toDbEnum(status) : undefined,
        before: after ? { at: new Date(after.t), id: after.i } : null,
        limit,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((s) => toDto(s)),
        pageInfo: {
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.startedAt.toISOString(), i: last.id })
              : null,
          hasMore: rows.length > limit,
        },
      };
    },

    /** POST /v1/fasts/:id/struggles ve /v1/struggles */
    async logStruggle(userId, fastId, body) {
      let elapsedMinutes = null;
      if (fastId) {
        const s = await mustFind(userId, fastId);
        const end = s.endedAt ?? new Date();
        elapsedMinutes = Math.max(0, Math.floor((end.getTime() - s.startedAt.getTime()) / 60_000));
      }
      const id = await repo.insertStruggle(db, userId, {
        sessionId: fastId,
        reason: body.reason,
        tip: body.tip,
        tipCompleted: body.tipCompleted,
        outcome: body.outcome ? toDbEnum(body.outcome) : null,
        elapsedMinutes,
      });
      return { id, elapsedMinutes };
    },
  };
  return service;
}

function auditEntry(userId, action, fastId, meta = {}, metadata) {
  return {
    actorType: 'user',
    actorId: userId,
    action,
    entityType: 'fasting_session',
    entityId: fastId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    metadata,
  };
}
