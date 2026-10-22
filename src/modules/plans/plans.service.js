import { AppError } from '../../shared/errors.js';
import { toApiEnum, toDbEnum } from '../../shared/enums.js';
import { toBin } from '../../shared/ids.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination.js';
import { addDays, isValidTimezone, isoDate, isoWeekday, localDate } from '../../shared/time.js';
import { writeAudit } from '../audit/audit.repository.js';
import * as userRepo from '../user/user.repository.js';
import { ageFromBirthYear, evaluateSafety } from '../user/onboarding.rules.js';
import * as repo from './plans.repository.js';
import {
  DEFAULT_FAST_MINUTES,
  dayTarget,
  resolveDailyWindow,
  resolveWeeklySchedule,
} from './plans.rules.js';

const DAILY = new Set(['daily', 'custom_daily']);
const CHECKIN_PAST_DAYS = 7;

/**
 * Kullanıcı planı (docs/backend/04-api.md §5, 05 §2). Plan değişimi bir sonraki oruçtan itibaren
 * geçerlidir; aktif oruç etkilenmez (hedefi seansta saklıdır).
 */
export function createPlansService({ db, catalog, stats }) {
  async function userContext(userId, conn) {
    const user = await userRepo.getUserWithUnits(db, userId, conn);
    if (!user) throw new AppError('NOT_FOUND');
    const tz = isValidTimezone(user.timezone) ? user.timezone : 'UTC';
    return { user, tz, today: localDate(Date.now(), tz) };
  }

  async function toDto(userPlan, locale) {
    if (!userPlan) return null;
    const detail = await catalog.planDetail(userPlan.planCode, locale);
    return {
      id: userPlan.id,
      planCode: userPlan.planCode,
      displayName: detail?.displayName ?? userPlan.planCode,
      category: detail?.category ?? null,
      scheduleType: detail?.scheduleType ?? null,
      timing: toApiEnum(userPlan.timing),
      fastMinutes: userPlan.fastMinutes,
      eatWindow: userPlan.eatWindow,
      weeklySchedule: userPlan.weeklySchedule,
      startedOn: isoDate(userPlan.startedOn),
      isPremium: detail?.isPremium ?? false,
      requiresSafetyAck: detail?.requiresSafetyAck ?? false,
      safetyAcknowledgedAt: userPlan.safetyAckAt ? userPlan.safetyAckAt.toISOString() : null,
    };
  }

  /**
   * Plan seçimini doğrular ve user_plans kaydına dönüştürür (DB'ye yazmaz).
   * @param options.skipSafety onboarding gibi güvenliği zaten değerlendirmiş akışlar için
   */
  async function buildPlan(userId, body, { conn, hasPremium = false, skipSafety = false, today }) {
    const plan = await catalog.planRules(body.planCode);
    if (!plan) {
      throw new AppError('VALIDATION_FAILED', {
        details: { fields: [{ path: 'planCode', message: 'unknown plan' }] },
      });
    }
    if (plan.isPremium && !hasPremium) {
      throw new AppError('PREMIUM_REQUIRED', { details: { planCode: plan.code } });
    }
    if (!skipSafety) {
      const profile = await userRepo.getProfile(db, userId, conn);
      const age = ageFromBirthYear(profile?.birth_year, today);
      const healthFlags = (profile?.health_flags ?? '').split(',').filter(Boolean);
      const safety = evaluateSafety({
        age,
        healthFlags,
        plan,
        safetyAcknowledged: body.safetyAcknowledged,
      });
      if (safety.error) {
        throw new AppError(safety.error.code, { details: { reason: safety.error.reason } });
      }
      if (plan.requiresSafetyAck && !body.safetyAcknowledged) {
        throw new AppError('SAFETY_ACK_REQUIRED', { details: { reason: 'plan_requires_ack' } });
      }
    }

    if (DAILY.has(plan.scheduleType)) {
      const resolved = resolveDailyWindow(plan, {
        timing: body.timing ? toDbEnum(body.timing) : undefined,
        eatStart: body.eatWindow?.start,
        eatEnd: body.eatWindow?.end,
        fastMinutes: body.fastMinutes,
      });
      return { plan, record: { ...resolved, weeklySchedule: null } };
    }
    const weeklySchedule = resolveWeeklySchedule(plan, body.weeklySchedule, plan.weeklyTemplate);
    const firstFast = weeklySchedule.find((d) => d.type === 'fast');
    return {
      plan,
      record: {
        timing: null,
        fastMinutes: firstFast?.fastMinutes ?? DEFAULT_FAST_MINUTES,
        eatWindow: null,
        weeklySchedule,
      },
    };
  }

  const service = {
    /** Fasting servisi için: aktif plan (ham). */
    findCurrent: (userId, conn) => repo.findCurrent(db, userId, conn),

    /** Bir yerel güne göre oruç hedefi; plan yoksa varsayılan 16 sa. */
    async targetFor(userId, isoDay, conn) {
      const current = await repo.findCurrent(db, userId, conn);
      if (!current) return { userPlan: null, fastMinutes: DEFAULT_FAST_MINUTES, dayType: 'fast' };
      const target = dayTarget(current, isoWeekday(isoDay));
      return {
        userPlan: current,
        fastMinutes: target.fastMinutes ?? current.fastMinutes,
        dayType: target.type,
      };
    },

    async current(userId, locale, { profileRow } = {}) {
      const current = await repo.findCurrent(db, userId);
      // Ana sayfa özeti profili zaten yüklediyse ikinci RTT'yi atla.
      const profile = profileRow ?? (await userRepo.getProfileCore(db, userId));
      return {
        plan: await toDto(current, locale),
        // Onboarding'de seçilip (premium olduğu için) henüz etkinleşmemiş plan.
        pendingPlanCode:
          profile?.plan_code && profile.plan_code !== current?.planCode ? profile.plan_code : null,
      };
    },

    /**
     * Planı etkinleştirir: eski plan kapanır, yenisi bugünden başlar.
     * `conn` verilirse çağıranın transaction'ında çalışır (onboarding).
     */
    async activate(userId, body, { conn, hasPremium = false, skipSafety = false, meta = {} } = {}) {
      const run = async (c) => {
        // Kullanıcı satırı kilidi: eşzamanlı plan değişimlerini sıraya sokar.
        await db.one('SELECT id FROM users WHERE id = :id FOR UPDATE', { id: toBin(userId) }, c);
        const { today } = await userContext(userId, c);
        const { plan, record } = await buildPlan(userId, body, {
          conn: c,
          hasPremium,
          skipSafety,
          today,
        });
        await repo.endCurrent(db, c, userId);
        const id = await repo.insertPlan(db, c, userId, {
          planCode: plan.code,
          ...record,
          safetyAckAt: body.safetyAcknowledged ? new Date() : null,
          startedOn: today,
        });
        await userRepo.upsertProfile(db, c, userId, { plan_code: plan.code });
        // Gün tipleri (zorunlu/nötr) bugünden itibaren değişir: seri yeniden hesaplanır.
        await stats.recompute(userId, { from: today, conn: c });
        await writeAudit(
          db,
          {
            actorType: 'user',
            actorId: userId,
            action: 'plan.changed',
            entityType: 'user_plan',
            entityId: id,
            ip: meta.ip,
            userAgent: meta.userAgent,
            metadata: { planCode: plan.code },
          },
          c,
        );
        return id;
      };
      return conn ? run(conn) : db.withTransaction(run);
    },

    async activateAndGet(userId, body, options, locale) {
      await service.activate(userId, body, options);
      return service.current(userId, locale);
    },

    /** Haftalık planlarda azaltılmış/oruç gününü işaretler (05 §2.2). */
    async checkin(userId, isoDay, status) {
      const { today } = await userContext(userId);
      if (isoDay > today || isoDay < addDays(today, -CHECKIN_PAST_DAYS)) {
        throw new AppError('VALIDATION_FAILED', {
          details: {
            fields: [
              { path: 'date', message: `must be within the last ${CHECKIN_PAST_DAYS} days` },
            ],
          },
        });
      }
      const { userPlan, dayType } = await service.targetFor(userId, isoDay);
      if (!userPlan?.weeklySchedule || !['reduced', 'fast'].includes(dayType)) {
        throw new AppError('CONFLICT', { details: { reason: 'not_a_plan_day' } });
      }
      await db.withTransaction(async (conn) => {
        await db.one('SELECT id FROM users WHERE id = :id FOR UPDATE', { id: toBin(userId) }, conn);
        await repo.upsertCheckin(db, userId, { localDate: isoDay, dayType, status }, conn);
        await stats.recompute(userId, { from: isoDay, conn });
      });
      return { date: isoDay, dayType, status };
    },

    async history(userId, locale, { limit = 20, cursor }) {
      const after = decodeCursor(cursor, ['t']);
      const rows = await repo.listHistory(db, userId, {
        limit,
        before: after ? new Date(after.t) : null,
      });
      const page = rows.slice(0, limit);
      const items = [];
      for (const r of page) {
        const dto = await toDto(repo.toUserPlan(r), locale);
        items.push({ ...dto, endedAt: r.ended_at ? r.ended_at.toISOString() : null });
      }
      const last = page.at(-1);
      return {
        items,
        pageInfo: {
          nextCursor:
            rows.length > limit && last ? encodeCursor({ t: last.created_at.toISOString() }) : null,
          hasMore: rows.length > limit,
        },
      };
    },
  };
  return service;
}
