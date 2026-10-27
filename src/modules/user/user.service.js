import { AppError } from '../../shared/errors.js';
import { apiToSet, setToApi, toApiEnum, toDbEnum } from '../../shared/enums.js';
import { toBin } from '../../shared/ids.js';
import { isValidTimezone, isoDate, localDate } from '../../shared/time.js';
import { writeAudit } from '../audit/audit.repository.js';
import { findSteps } from '../trackers/trackers.repository.js';
import { stepKcal } from '../trackers/trackers.rules.js';
import { computeNutritionGoals, nutritionInputs } from './nutrition.rules.js';
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
import { healthConsentKey } from '../account/account.service.js';
import * as repo from './user.repository.js';

/** Sağlık verisi ve AI rızalarının kaydedildiği belge sürümü yoksa gizlilik metninin sürümü kullanılır. */
const CONSENT_SOURCE_ONBOARDING = 'onboarding';

/**
 * Kullanıcı, onboarding, profil, ayarlar, hedefler (docs/backend/04-api.md §2).
 * `meta`: { ip, userAgent, timezone }
 */
export function createUserService({ db, cache, catalog, plans, stats, media, entitlements }) {
  async function requireUser(userId, conn) {
    const row = await repo.getUserWithUnits(db, userId, conn);
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  function todayFor(timezone) {
    return localDate(Date.now(), isValidTimezone(timezone) ? timezone : 'UTC');
  }

  /** Katalogdaki plan; bilinmeyen kod → 400. */
  async function resolvePlan(code) {
    const plan = await catalog.planRules(code);
    if (!plan) throw validation('planCode', 'unknown plan');
    return plan;
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
      const row = await requireUser(userId);
      const dto = toMeDto(row);
      // Avatar / premium / rıza birbirinden bağımsız — uzak DB'de paralel.
      const [avatarUrl, isPremium, consents] = await Promise.all([
        media?.avatarUrl(userId) ?? Promise.resolve(null),
        entitlements?.isPremium(userId) ?? Promise.resolve(false),
        row.onboarding_completed_at ? requiredConsents(userId) : Promise.resolve([]),
      ]);
      return {
        ...dto,
        avatarUrl: avatarUrl ?? null,
        isPremium: isPremium ?? false,
        // Ürün düzeyindeki ad (RevenueCat entitlement kimliğinden bağımsız; 04 §3).
        entitlements: isPremium ? ['premium'] : [],
        requiredConsents: consents,
      };
    },

    /**
     * Ana sayfa özeti: /me ile aynı kimlik alanları, rıza sorgusu yok (summary için gereksiz
     * ve yavaştı). Avatar + premium paralel.
     */
    async summaryHeader(userId) {
      const row = await requireUser(userId);
      const [avatarUrl, isPremium] = await Promise.all([
        media?.avatarUrl(userId) ?? Promise.resolve(null),
        entitlements?.isPremium(userId) ?? Promise.resolve(false),
      ]);
      return {
        id: row.id,
        name: row.display_name ?? null,
        avatarUrl: avatarUrl ?? null,
        isPremium: isPremium ?? false,
        isGuest: Boolean(row.is_guest),
        timezone: row.timezone,
        units: {
          weight: row.weight_unit,
          height: toApiEnum(row.height_unit),
          water: row.water_unit,
        },
      };
    },

    /**
     * Ana sayfa hedefleri: adım okuma / ensureDefaults yok (onboarding sonrası satırlar var).
     * `profileRow` ham profil (nutritionInputs snake_case).
     */
    async summaryGoals(userId, { profileRow, timezone }) {
      let goals = await repo.getGoals(db, userId);
      if (!goals) {
        await ensureRows(userId);
        goals = await repo.getGoals(db, userId);
      }
      const today = todayFor(timezone);
      return toGoalsDto(goals ?? {}, computedGoals(profileRow, today, 0));
    },

    /** Ana sayfa kilo / kcal için hafif profil DTO (yiyecek/engel listeleri yok). */
    async summaryProfile(userId, { timezone } = {}) {
      const row = await repo.getProfileCore(db, userId);
      if (!row) {
        const user = await requireUser(userId);
        return { dto: toProfileDto(null, user, todayFor(user.timezone)), row: null };
      }
      const tz = timezone ?? (await requireUser(userId)).timezone;
      const today = todayFor(tz);
      // toProfileDto birim için user ister; core satırında birimler var.
      const userUnits = {
        weight_unit: row.weight_unit,
        height_unit: row.height_unit,
        water_unit: row.water_unit,
      };
      return { dto: toProfileDto(row, userUnits, today), row };
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

      const plan = await resolvePlan(body.planCode);
      // Onboarding sırasında satın alan kullanıcıda premium plan hemen etkin.
      const hasPremium = plan.isPremium && ((await entitlements?.isPremium(userId)) ?? false);
      const healthFlags = [...(body.healthFlags ?? []).map(toDbEnum)];
      if (body.age < 18) healthFlags.push('under_18');
      const warnings = [
        ...enforceSafety(
          {
            age: body.age,
            healthFlags,
            plan,
            heightCm: body.heightCm,
            goalWeightKg: body.goalWeightKg,
          },
          body.safetyAcknowledged,
        ),
        ...mealWindowWarnings(plan, body.mealWindow),
      ];
      const fastingReason = toDbEnum(body.fastingReason);
      const targetDate = reasonTargetDate(fastingReason, today);
      const summary = planSummary(plan, body.mealWindow);

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
        // Ücretsiz plan (ya da premium kullanıcının planı) hemen aktif olur; premium plan
        // satın alınınca etkinleşir, o zamana kadar profilde bekler
        // (GET /v1/plans/current → pendingPlanCode).
        // Haftalık planlar (5:2, gün aşırı…) yeme penceresi olmadan, katalog şablonuyla.
        if (!plan.isPremium || hasPremium) {
          await plans.activate(
            userId,
            summary.eatWindow
              ? { planCode: plan.code, timing: 'custom', eatWindow: summary.eatWindow }
              : { planCode: plan.code },
            { conn, hasPremium, skipSafety: true, meta },
          );
        }
        // Onboarding kilosu bugünün özetine ve kilo XP'sine yazılır.
        await db.one('SELECT id FROM users WHERE id = :id FOR UPDATE', { id: toBin(userId) }, conn);
        await stats.applyDay(userId, today, conn);
        await audit(conn, meta, 'user.onboarding_completed', userId, {
          schemaVersion: body.schemaVersion,
          planCode: body.planCode,
        });
      });

      return {
        user: await service.getMe(userId),
        plan: summary,
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
        const planCode = body.planCode ?? current?.plan_code ?? null;
        // Profildeki eski kod katalogdan kalkmış olabilir: yalnızca yeni gönderilen kod zorunlu.
        const plan = body.planCode
          ? await resolvePlan(body.planCode)
          : planCode
            ? await catalog.planRules(planCode)
            : null;
        const heightCm = body.heightCm ?? current?.height_cm ?? null;

        // Hedef, kayıtlı kilonun üstüne de çekilebilir (hedefe varınca yeni
        // hedef). Onboarding hâlâ başlangıç kilosunun üstünü reddeder.
        if (body.mealWindow && body.mealWindow.start === body.mealWindow.end) {
          throw validation('mealWindow', 'end must differ from start');
        }
        warnings = enforceSafety(
          { age, healthFlags, plan, heightCm, goalWeightKg },
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
          await db.one(
            'SELECT id FROM users WHERE id = :id FOR UPDATE',
            { id: toBin(userId) },
            conn,
          );
          await stats.applyDay(userId, today, conn);
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
      // Önce oku; satır yoksa (eski hesap) bir kez oluştur. Her okumada transaction +
      // 3 upsert atmak gereksiz gidiş-dönüştü (uzak DB'de ~250 ms).
      let settings = await repo.getSettings(db, userId);
      if (!settings) {
        await ensureRows(userId);
        settings = await repo.getSettings(db, userId);
      }
      return toSettingsDto(settings);
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
      if (body.showInChallenges !== undefined) fields.show_in_challenges = body.showInChallenges;
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
      const today = todayFor(user.timezone);
      const steps = await findSteps(db, userId, today);
      const inputs = nutritionInputs(profile, today);
      return toGoalsDto(goals, computedGoals(profile, today, stepKcal(steps, inputs)));
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
      // Uyku programı ilk kez kullanıcı tarafından ayarlandı (varsayılanlardan ayırt etmek için).
      if (['sleepGoalMin', 'bedtime', 'wakeTime'].some((k) => body[k] !== undefined)) {
        fields.sleep_schedule_set_at = new Date();
      }
      if (body.customGlassSizes !== undefined) {
        fields.custom_glass_sizes =
          body.customGlassSizes === null
            ? null
            : JSON.stringify([...new Set(body.customGlassSizes)]);
      }
      await db.withTransaction(async (conn) => {
        await repo.upsertGoals(db, conn, userId, fields);
        // Adım hedefi bugüne yazılır. Yarın bu değerle açılır; dünün hedefi durur.
        if (body.stepsGoal !== undefined) {
          const user = await requireUser(userId, conn);
          const today = todayFor(user.timezone);
          await db.one(
            'SELECT id FROM users WHERE id = :id FOR UPDATE',
            { id: toBin(userId) },
            conn,
          );
          await stats.applyDay(userId, today, conn);
        }
      });
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
        // Pazarlama rızası geri çekilince pazarlama bildirimi de kapanır (06 §8.1).
        if (body.type === 'marketingPush' && !body.granted) {
          await repo.upsertSettings(db, conn, userId, { notif_marketing: 0 });
        }
      });
      if (body.type === 'healthData') await cache?.del(healthConsentKey(userId));
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
  };

  /**
   * Yasal metin sürümü değiştiyse (app_config.legal) yeniden onay gereken türler (06 §8.1).
   * @returns API adları, ör. ['terms', 'privacy']
   */
  async function requiredConsents(userId) {
    const legal = (await catalog.appConfig('all')).legal ?? {};
    const current = { terms: legal.termsVersion, privacy: legal.privacyVersion };
    const latest = new Map((await repo.latestConsents(db, userId)).map((r) => [r.consent_type, r]));
    return Object.entries(current)
      .filter(([type, version]) => {
        if (!version) return false;
        const last = latest.get(type);
        return !last || !last.granted || last.document_version !== version;
      })
      .map(([type]) => type);
  }

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
  world: 'notif_world',
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

/** Önerilen hedefler; `stepKcal`: bugünün adım kalorisi (TDEE'ye eklenir, 05 §6.2). */
function computedGoals(profile, today, stepKcal = 0) {
  return computeNutritionGoals({ ...nutritionInputs(profile, today), stepKcal });
}

/** API kullanıcı modeli (04 §2 GET /v1/user/me). Avatar URL'si ve premium durumu servis ekler. */
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
    showInChallenges: Boolean(s.show_in_challenges),
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

function validation(path, message) {
  return new AppError('VALIDATION_FAILED', { details: { fields: [{ path, message }] } });
}
