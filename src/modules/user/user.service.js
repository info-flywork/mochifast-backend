import { AppError } from '../../shared/errors.js';
import { apiToSet, setToApi, toApiEnum, toDbEnum } from '../../shared/enums.js';
import { isValidTimezone, localDate } from '../../shared/time.js';
import { writeAudit } from '../audit/audit.repository.js';
import { computeNutritionGoals } from './nutrition.rules.js';
import {
  DEFAULT_WEEKLY_LOSS_KG,
  ageFromBirthYear,
  birthYearFromAge,
  bmi,
  evaluateSafety,
  mealWindowWarnings,
  planSummary,
  projection,
  reasonTargetDate,
} from './onboarding.rules.js';
import * as repo from './user.repository.js';

/** Sağlık verisi ve AI rızalarının kaydedildiği belge sürümü yoksa gizlilik metninin sürümü kullanılır. */
const CONSENT_SOURCE_ONBOARDING = 'onboarding';

/**
 * Kullanıcı, onboarding, profil, ayarlar, hedefler (docs/backend/04-api.md §2).
 * `meta`: { ip, userAgent, timezone }
 */
export function createUserService({ db }) {
  async function requireUser(userId, conn) {
    const row = await repo.getUserWithUnits(db, userId, conn);
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  function todayFor(timezone) {
    return localDate(Date.now(), isValidTimezone(timezone) ? timezone : 'UTC');
  }

  /** Profil + yeni değerlerle sağlık kurallarını değerlendirir; ihlalde AppError fırlatır. */
  function enforceSafety(state, safetyAcknowledged) {
    const result = evaluateSafety({ ...state, safetyAcknowledged });
    if (result.error) {
      throw new AppError(result.error.code, { details: { reason: result.error.reason } });
    }
    return result.warnings;
  }

  function audit(conn, meta, action, userId, metadata) {
    return writeAudit(
      db,
      {
        actorType: 'user',
        actorId: userId,
        action,
        entityType: 'user',
        entityId: userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata,
      },
      conn,
    );
  }

  const service = {
    async getMe(userId) {
      return toMeDto(await requireUser(userId));
    },

    async updateMe(userId, body) {
      if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
        throw validation('timezone', 'invalid IANA timezone');
      }
      await db.withTransaction(async (conn) => {
        await repo.updateUser(db, conn, userId, {
          displayName: body.name?.trim(),
          locale: body.locale,
          timezone: body.timezone,
        });
        if (body.units) {
          const units = {};
          if (body.units.weight) units.weight_unit = body.units.weight;
          if (body.units.height) units.height_unit = toDbEnum(body.units.height);
          if (body.units.water) units.water_unit = body.units.water;
          await repo.upsertProfile(db, conn, userId, units);
        }
      });
      return service.getMe(userId);
    },

    /**
     * Onboarding'in tamamı tek transaction'da (04 §2 POST /v1/user/onboarding).
     */
    async submitOnboarding(userId, body, meta) {
      const userRow = await requireUser(userId);
      const timezone = isValidTimezone(meta.timezone) ? meta.timezone : userRow.timezone;
      const today = todayFor(timezone);
      const goal = toDbEnum(body.goal);

      if (goal === 'lose_weight' && body.goalWeightKg > body.weightKg) {
        throw validation('goalWeightKg', 'must not exceed weightKg when goal is loseWeight');
      }
      if (body.mealWindow.start === body.mealWindow.end) {
        throw validation('mealWindow', 'end must differ from start');
      }
      if (body.consents.healthData !== true) {
        throw new AppError('CONSENT_REQUIRED', { details: { consent: 'healthData' } });
      }

      const healthFlags = [...(body.healthFlags ?? []).map(toDbEnum)];
      if (body.age < 18) healthFlags.push('under_18');
      const warnings = [
        ...enforceSafety(
          {
            age: body.age,
            healthFlags,
            planCode: body.planCode,
            heightCm: body.heightCm,
            goalWeightKg: body.goalWeightKg,
          },
          body.safetyAcknowledged,
        ),
        ...mealWindowWarnings(body.planCode, body.mealWindow),
      ];
      const fastingReason = toDbEnum(body.fastingReason);
      const targetDate = reasonTargetDate(fastingReason, today);

      await db.withTransaction(async (conn) => {
        await repo.upsertProfile(db, conn, userId, {
          gender: toDbEnum(body.gender),
          birth_year: birthYearFromAge(body.age, today),
          height_cm: body.heightCm,
          start_weight_kg: body.weightKg,
          goal_weight_kg: body.goalWeightKg,
          goal,
          diet: toDbEnum(body.diet),
          weight_history: toDbEnum(body.weightHistory),
          fasting_reason: fastingReason,
          target_date: targetDate,
          meal_window_start: body.mealWindow.start,
          meal_window_end: body.mealWindow.end,
          plan_code: body.planCode,
          health_flags: apiToSet(healthFlags.map(toApiEnum)),
          health_screened_at: body.healthFlags ? new Date() : null,
        });
        await repo.replaceFoodPreferences(db, conn, userId, 'love', body.foodLoves.map(toDbEnum));
        await repo.replaceFoodPreferences(
          db,
          conn,
          userId,
          'skip',
          (body.foodSkips ?? []).map(toDbEnum),
        );
        await repo.replaceObstacles(db, conn, userId, (body.obstacles ?? []).map(toDbEnum));
        await repo.insertSubmission(db, conn, userId, body.schemaVersion, body);
        await repo.upsertOnboardingWeight(db, conn, userId, {
          weightKg: body.weightKg,
          localDate: today,
          tz: timezone,
        });
        await repo.ensureDefaults(db, conn, userId);
        await repo.insertConsents(db, conn, userId, onboardingConsents(body.consents), {
          ip: meta.ip,
          source: CONSENT_SOURCE_ONBOARDING,
        });
        if (timezone !== userRow.timezone) await repo.updateUser(db, conn, userId, { timezone });
        await repo.markOnboarded(db, conn, userId);
        await audit(conn, meta, 'user.onboarding_completed', userId, {
          schemaVersion: body.schemaVersion,
          planCode: body.planCode,
        });
      });

      return {
        user: await service.getMe(userId),
        plan: planSummary(body.planCode, body.mealWindow),
        projection: projection({
          currentKg: body.weightKg,
          goalKg: body.goalWeightKg,
          weeklyLossKg: DEFAULT_WEEKLY_LOSS_KG,
          todayIso: today,
        }),
        targetDate,
        warnings,
      };
    },

    async getProfile(userId) {
      const user = await requireUser(userId);
      const profile = await repo.getProfile(db, userId);
      return toProfileDto(profile, user, todayFor(user.timezone));
    },

    /**
     * Edit Profile. Sağlık kuralları birleşmiş (mevcut + yeni) durum üzerinde yeniden uygulanır.
     * `weightKg` profil alanı değil, yeni bir kilo kaydıdır.
     */
    async updateProfile(userId, body, meta) {
      const user = await requireUser(userId);
      const today = todayFor(user.timezone);
      let warnings = [];

      await db.withTransaction(async (conn) => {
        const current = await repo.getProfile(db, userId, conn, { forUpdate: true });
        const age = body.age ?? ageFromBirthYear(current?.birth_year, today);
        const clientFlags =
          body.healthFlags !== undefined
            ? body.healthFlags.map(toDbEnum)
            : (current?.health_flags ?? '').split(',').filter((f) => f && f !== 'under_18');
        const healthFlags = age !== null && age < 18 ? [...clientFlags, 'under_18'] : clientFlags;
        const goal = body.goal !== undefined ? toDbEnum(body.goal) : current?.goal;
        const goalWeightKg = body.goalWeightKg ?? current?.goal_weight_kg ?? null;
        const weightKg = body.weightKg ?? current?.current_weight_kg ?? current?.start_weight_kg;
        const planCode = body.planCode ?? current?.plan_code ?? null;
        const heightCm = body.heightCm ?? current?.height_cm ?? null;

        if (goal === 'lose_weight' && goalWeightKg && weightKg && goalWeightKg > weightKg) {
          throw validation(
            'goalWeightKg',
            'must not exceed current weight when goal is loseWeight',
          );
        }
        if (body.mealWindow && body.mealWindow.start === body.mealWindow.end) {
          throw validation('mealWindow', 'end must differ from start');
        }
        warnings = enforceSafety(
          { age, healthFlags, planCode, heightCm, goalWeightKg },
          body.safetyAcknowledged,
        );

        const fields = {};
        if (body.gender !== undefined) fields.gender = toDbEnum(body.gender);
        if (body.age !== undefined) fields.birth_year = birthYearFromAge(body.age, today);
        if (body.heightCm !== undefined) fields.height_cm = body.heightCm;
        if (body.goalWeightKg !== undefined) fields.goal_weight_kg = body.goalWeightKg;
        if (body.goal !== undefined) fields.goal = goal;
        if (body.diet !== undefined) fields.diet = toDbEnum(body.diet);
        if (body.weightHistory !== undefined) fields.weight_history = toDbEnum(body.weightHistory);
        if (body.fastingReason !== undefined) {
          fields.fasting_reason = toDbEnum(body.fastingReason);
          fields.target_date = reasonTargetDate(fields.fasting_reason, today);
        }
        if (body.mealWindow !== undefined) {
          fields.meal_window_start = body.mealWindow.start;
          fields.meal_window_end = body.mealWindow.end;
        }
        if (body.planCode !== undefined) fields.plan_code = body.planCode;
        if (body.healthFlags !== undefined || body.age !== undefined) {
          fields.health_flags = apiToSet(healthFlags.map(toApiEnum));
        }
        if (body.healthFlags !== undefined) fields.health_screened_at = new Date();
        if (!current && body.weightKg !== undefined) fields.start_weight_kg = body.weightKg;

        await repo.upsertProfile(db, conn, userId, fields);
        if (body.foodLoves) {
          await repo.replaceFoodPreferences(db, conn, userId, 'love', body.foodLoves.map(toDbEnum));
        }
        if (body.foodSkips) {
          await repo.replaceFoodPreferences(db, conn, userId, 'skip', body.foodSkips.map(toDbEnum));
        }
        if (body.obstacles) {
          await repo.replaceObstacles(db, conn, userId, body.obstacles.map(toDbEnum));
        }
        if (body.weightKg !== undefined) {
          await repo.insertWeight(db, conn, userId, {
            weightKg: body.weightKg,
            localDate: today,
            tz: user.timezone,
          });
        }
        if (body.healthFlags !== undefined) {
          await audit(conn, meta, 'user.health_flags_updated', userId, {
            count: clientFlags.length,
          });
        }
      });

      return { ...(await service.getProfile(userId)), warnings };
    },

    async getSettings(userId) {
      await ensureRows(userId);
      return toSettingsDto(await repo.getSettings(db, userId));
    },

    async updateSettings(userId, body) {
      const fields = {};
      if (body.pushEnabled !== undefined) fields.push_enabled = body.pushEnabled;
      for (const [key, column] of Object.entries(NOTIFICATION_COLUMNS)) {
        if (body.notifications?.[key] !== undefined) fields[column] = body.notifications[key];
      }
      if (body.waterReminderIntervalMin !== undefined) {
        fields.water_reminder_interval_min = body.waterReminderIntervalMin;
      }
      if (body.quietHours) {
        fields.quiet_hours_start = body.quietHours.start;
        fields.quiet_hours_end = body.quietHours.end;
      }
      if (body.healthSyncEnabled !== undefined) fields.health_sync_enabled = body.healthSyncEnabled;
      await db.withTransaction((conn) => repo.upsertSettings(db, conn, userId, fields));
      return service.getSettings(userId);
    },

    async getGoals(userId) {
      await ensureRows(userId);
      const user = await requireUser(userId);
      const [goals, profile] = await Promise.all([
        repo.getGoals(db, userId),
        repo.getProfile(db, userId),
      ]);
      return toGoalsDto(goals, computedGoals(profile, todayFor(user.timezone)));
    },

    async updateGoals(userId, body) {
      const map = {
        waterGoalMl: 'water_goal_ml',
        glassSizeMl: 'glass_size_ml',
        stepsGoal: 'steps_goal',
        kcalGoal: 'kcal_goal',
        proteinGoalG: 'protein_goal_g',
        carbsGoalG: 'carbs_goal_g',
        fatGoalG: 'fat_goal_g',
        sleepGoalMin: 'sleep_goal_min',
        bedtime: 'bedtime',
        wakeTime: 'wake_time',
      };
      const fields = {};
      for (const [key, column] of Object.entries(map)) {
        if (body[key] !== undefined) fields[column] = body[key];
      }
      if (body.customGlassSizes !== undefined) {
        fields.custom_glass_sizes =
          body.customGlassSizes === null
            ? null
            : JSON.stringify([...new Set(body.customGlassSizes)]);
      }
      await db.withTransaction((conn) => repo.upsertGoals(db, conn, userId, fields));
      return service.getGoals(userId);
    },

    async addConsent(userId, body, meta) {
      await db.withTransaction(async (conn) => {
        await repo.insertConsents(
          db,
          conn,
          userId,
          [{ type: toDbEnum(body.type), version: body.version, granted: body.granted }],
          { ip: meta.ip, source: body.source ?? 'settings' },
        );
        await audit(conn, meta, 'user.consent_changed', userId, {
          type: body.type,
          version: body.version,
          granted: body.granted,
        });
      });
      return service.listConsents(userId);
    },

    async listConsents(userId) {
      const rows = await repo.latestConsents(db, userId);
      const seen = new Set();
      const items = [];
      for (const r of rows) {
        if (seen.has(r.consent_type)) continue;
        seen.add(r.consent_type);
        items.push({
          type: toApiEnum(r.consent_type),
          version: r.document_version,
          granted: Boolean(r.granted),
          at: r.created_at.toISOString(),
        });
      }
      return { items };
    },

    /** F1 iskeleti: user_stats satırından (F3'te gerçek oruç verisiyle dolar). */
    async getProgress(userId) {
      const stats = await repo.getStats(db, userId);
      return {
        level: stats?.level ?? 1,
        streakDays: stats?.current_streak ?? 0,
        completedFasts: stats?.completed_fasts ?? 0,
        xp: stats?.xp ?? 0,
      };
    },
  };

  async function ensureRows(userId) {
    await db.withTransaction((conn) => repo.ensureDefaults(db, conn, userId));
  }

  return service;
}

const NOTIFICATION_COLUMNS = {
  fasting: 'notif_fasting',
  streak: 'notif_streak',
  weight: 'notif_weight',
  water: 'notif_water',
  challenges: 'notif_challenges',
  marketing: 'notif_marketing',
};

function onboardingConsents(c) {
  const list = [
    { type: 'terms', version: c.terms, granted: true },
    { type: 'privacy', version: c.privacy, granted: true },
    { type: 'health_data', version: c.privacy, granted: true },
  ];
  if (c.aiProcessing !== undefined) {
    list.push({ type: 'ai_processing', version: c.privacy, granted: c.aiProcessing });
  }
  return list;
}

function computedGoals(profile, today) {
  if (!profile) return computeNutritionGoals({});
  return computeNutritionGoals({
    weightKg: profile.current_weight_kg ?? profile.start_weight_kg,
    heightCm: profile.height_cm,
    age: ageFromBirthYear(profile.birth_year, today),
    gender: profile.gender,
    goal: profile.goal,
    goalWeightKg: profile.goal_weight_kg,
    diet: profile.diet,
    weeklyLossKg: profile.weekly_loss_target_kg,
    healthFlags: (profile.health_flags ?? '').split(',').filter(Boolean),
  });
}

/** API kullanıcı modeli (04 §2 GET /v1/user/me). Avatar F5'te, premium F8'de bağlanır. */
export function toMeDto(row) {
  return {
    id: row.id,
    name: row.display_name ?? null,
    email: row.email ?? null,
    avatarUrl: null,
    isGuest: Boolean(row.is_guest),
    isPremium: false,
    isAnsweredQuestions: row.onboarding_completed_at !== null,
    locale: row.locale,
    timezone: row.timezone,
    units: {
      weight: row.weight_unit,
      height: toApiEnum(row.height_unit),
      water: row.water_unit,
    },
    entitlements: [],
    createdAt: row.created_at.toISOString(),
  };
}

function toProfileDto(p, user, today) {
  const age = ageFromBirthYear(p?.birth_year, today);
  const currentWeightKg = p?.current_weight_kg ?? p?.start_weight_kg ?? null;
  return {
    gender: toApiEnum(p?.gender ?? null),
    age,
    heightCm: p?.height_cm ?? null,
    startWeightKg: p?.start_weight_kg ?? null,
    currentWeightKg,
    goalWeightKg: p?.goal_weight_kg ?? null,
    bmi: currentWeightKg && p?.height_cm ? bmi(currentWeightKg, p.height_cm) : null,
    goal: toApiEnum(p?.goal ?? null),
    diet: toApiEnum(p?.diet ?? null),
    weightHistory: toApiEnum(p?.weight_history ?? null),
    fastingReason: toApiEnum(p?.fasting_reason ?? null),
    targetDate: p?.target_date ? isoDate(p.target_date) : null,
    weeklyLossKg: p?.weekly_loss_target_kg ?? DEFAULT_WEEKLY_LOSS_KG,
    mealWindow:
      p?.meal_window_start && p?.meal_window_end
        ? { start: hhmm(p.meal_window_start), end: hhmm(p.meal_window_end) }
        : null,
    planCode: p?.plan_code ?? null,
    // under_18 yaştan türetilen iç işarettir; istemciye gösterilmez.
    healthFlags: setToApi(p?.health_flags).filter((f) => f !== 'under_18'),
    foodLoves: (p?.food_loves ?? []).map(toApiEnum),
    foodSkips: (p?.food_skips ?? []).map(toApiEnum),
    obstacles: (p?.obstacles ?? []).map(toApiEnum),
    units: {
      weight: user.weight_unit,
      height: toApiEnum(user.height_unit),
      water: user.water_unit,
    },
  };
}

function toSettingsDto(s) {
  return {
    pushEnabled: s.push_enabled,
    notifications: Object.fromEntries(
      Object.entries(NOTIFICATION_COLUMNS).map(([key, column]) => [key, s[column]]),
    ),
    waterReminderIntervalMin: s.water_reminder_interval_min,
    quietHours: { start: hhmm(s.quiet_hours_start), end: hhmm(s.quiet_hours_end) },
    healthSyncEnabled: s.health_sync_enabled,
  };
}

function toGoalsDto(g, computed) {
  const custom =
    typeof g.custom_glass_sizes === 'string'
      ? JSON.parse(g.custom_glass_sizes)
      : g.custom_glass_sizes;
  return {
    waterGoalMl: g.water_goal_ml,
    glassSizeMl: g.glass_size_ml,
    customGlassSizes: custom ?? [],
    stepsGoal: g.steps_goal,
    kcalGoal: g.kcal_goal,
    proteinGoalG: g.protein_goal_g,
    carbsGoalG: g.carbs_goal_g,
    fatGoalG: g.fat_goal_g,
    computed,
    sleepGoalMin: g.sleep_goal_min,
    bedtime: hhmm(g.bedtime),
    wakeTime: hhmm(g.wake_time),
  };
}

const hhmm = (time) => String(time).slice(0, 5);
const isoDate = (value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

function validation(path, message) {
  return new AppError('VALIDATION_FAILED', { details: { fields: [{ path, message }] } });
}
