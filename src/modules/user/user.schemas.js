import {
  eatingWindowSchema,
  fastSchema,
  statsTotalsSchema,
  weekDaySchema,
} from '../fasting/fasting.schemas.js';
import { challengeSchema } from '../gamification/gamification.schemas.js';
import { userPlanSchema } from '../plans/plans.schemas.js';
import {
  CONSENT_TYPES,
  DIETS,
  FASTING_REASONS,
  FOOD_LOVES,
  FOOD_SKIPS,
  GENDERS,
  GOALS,
  HEALTH_FLAGS,
  OBSTACLES,
  SUPPORTED_LOCALES,
  UNITS,
  WEIGHT_HISTORIES,
} from '../../config/constants.js';
import { envelope, localDateSchema, uuidSchema } from '../../shared/schemas.js';

const bearer = [{ bearerAuth: [] }];
const enumOf = (values) => ({ type: 'string', enum: values });
const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });
const listOf = (values, extra = {}) => ({
  type: 'array',
  items: enumOf(values),
  uniqueItems: true,
  maxItems: values.length,
  ...extra,
});
// Katalogdaki kod (fasting_plans.code); varlığı serviste doğrulanır.
const planCodeSchema = { type: 'string', pattern: '^[a-z0-9_]{2,32}$' };
const hhmm = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' };
const timeWindow = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end'],
  properties: { start: hhmm, end: hhmm },
};
// Aralıklar: docs/backend/01-uygulama-analizi.md §2.1
const weightKg = { type: 'number', minimum: 30, maximum: 300 };
const heightCm = { type: 'number', minimum: 100, maximum: 250 };
const age = { type: 'integer', minimum: 13, maximum: 100 };
const unitsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    weight: enumOf(UNITS.weight),
    height: enumOf(UNITS.height),
    water: enumOf(UNITS.water),
  },
};

export const meSchema = {
  type: 'object',
  required: [
    'id',
    'name',
    'email',
    'avatarUrl',
    'isGuest',
    'isPremium',
    'isAnsweredQuestions',
    'locale',
    'timezone',
    'units',
    'entitlements',
    'createdAt',
  ],
  properties: {
    // Yasal metin sürümü değiştiyse yeniden onay istenecek türler (POST /user/consents).
    requiredConsents: { type: 'array', items: { type: 'string', enum: ['terms', 'privacy'] } },
    id: uuidSchema,
    name: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    avatarUrl: { type: ['string', 'null'] },
    isGuest: { type: 'boolean' },
    isPremium: { type: 'boolean' },
    isAnsweredQuestions: { type: 'boolean' },
    locale: { type: 'string' },
    timezone: { type: 'string' },
    units: unitsSchema,
    entitlements: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export const getMeSchema = {
  tags: ['user'],
  summary: 'Oturumdaki kullanıcı',
  security: bearer,
  response: { 200: envelope(meSchema) },
};

export const patchMeSchema = {
  tags: ['user'],
  summary: 'Ad, dil, saat dilimi, birimler',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' },
      locale: enumOf(SUPPORTED_LOCALES),
      timezone: { type: 'string', minLength: 1, maxLength: 64 },
      units: { ...unitsSchema, minProperties: 1 },
    },
  },
  response: { 200: envelope(meSchema) },
};

export const onboardingSchema = {
  tags: ['user'],
  summary: 'Onboarding cevaplarının tamamı (tek transaction)',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'goal',
      'gender',
      'weightKg',
      'goalWeightKg',
      'heightCm',
      'age',
      'diet',
      'foodLoves',
      'weightHistory',
      'fastingReason',
      'planCode',
      'mealWindow',
      'consents',
    ],
    properties: {
      schemaVersion: { type: 'integer', minimum: 1, maximum: 100 },
      goal: enumOf(GOALS),
      gender: enumOf(GENDERS),
      weightKg,
      goalWeightKg: weightKg,
      heightCm,
      age,
      diet: enumOf(DIETS),
      foodLoves: listOf(FOOD_LOVES, { minItems: 1 }),
      foodSkips: listOf(FOOD_SKIPS),
      weightHistory: enumOf(WEIGHT_HISTORIES),
      obstacles: listOf(OBSTACLES),
      fastingReason: enumOf(FASTING_REASONS),
      planCode: planCodeSchema,
      mealWindow: timeWindow,
      healthFlags: listOf(HEALTH_FLAGS),
      safetyAcknowledged: { type: 'boolean' },
      consents: {
        type: 'object',
        additionalProperties: false,
        required: ['terms', 'privacy', 'healthData'],
        properties: {
          terms: { type: 'string', minLength: 1, maxLength: 20 },
          privacy: { type: 'string', minLength: 1, maxLength: 20 },
          healthData: { type: 'boolean' },
          aiProcessing: { type: 'boolean' },
        },
      },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      required: ['user', 'plan', 'projection', 'targetDate', 'warnings'],
      properties: {
        user: meSchema,
        plan: {
          type: 'object',
          required: ['planCode', 'fastMinutes', 'eatWindow'],
          properties: {
            planCode: { type: 'string' },
            fastMinutes: { type: ['integer', 'null'] },
            eatWindow: {
              type: ['object', 'null'],
              properties: { start: { type: 'string' }, end: { type: 'string' } },
            },
          },
        },
        projection: {
          type: 'object',
          required: ['currentWeightKg', 'goalWeightKg', 'weeklyLossKg', 'targetDate', 'weeks'],
          properties: {
            currentWeightKg: { type: 'number' },
            goalWeightKg: { type: 'number' },
            weeklyLossKg: { type: 'number' },
            targetDate: localDateSchema,
            weeks: { type: 'integer' },
          },
        },
        targetDate: { type: ['string', 'null'], format: 'date' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    }),
  },
};

const profileProperties = {
  gender: nullable(enumOf(GENDERS)),
  age: { type: ['integer', 'null'] },
  heightCm: { type: ['number', 'null'] },
  startWeightKg: { type: ['number', 'null'] },
  currentWeightKg: { type: ['number', 'null'] },
  goalWeightKg: { type: ['number', 'null'] },
  bmi: { type: ['number', 'null'] },
  goal: nullable(enumOf(GOALS)),
  diet: nullable(enumOf(DIETS)),
  weightHistory: nullable(enumOf(WEIGHT_HISTORIES)),
  fastingReason: nullable(enumOf(FASTING_REASONS)),
  targetDate: { type: ['string', 'null'], format: 'date' },
  weeklyLossKg: { type: 'number' },
  mealWindow: { type: ['object', 'null'], properties: timeWindow.properties },
  planCode: { type: ['string', 'null'] },
  healthFlags: { type: 'array', items: { type: 'string' } },
  foodLoves: { type: 'array', items: { type: 'string' } },
  foodSkips: { type: 'array', items: { type: 'string' } },
  obstacles: { type: 'array', items: { type: 'string' } },
  units: unitsSchema,
};

const profileResponse = (withWarnings) =>
  envelope({
    type: 'object',
    properties: withWarnings
      ? { ...profileProperties, warnings: { type: 'array', items: { type: 'string' } } }
      : profileProperties,
  });

export const getProfileSchema = {
  tags: ['user'],
  summary: 'Edit Profile alanları',
  security: bearer,
  response: { 200: profileResponse(false) },
};

export const patchProfileSchema = {
  tags: ['user'],
  summary: 'Profil güncelleme (weightKg → yeni kilo kaydı)',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      gender: enumOf(GENDERS),
      age,
      heightCm,
      weightKg,
      goal: enumOf(GOALS),
      goalWeightKg: weightKg,
      diet: enumOf(DIETS),
      weightHistory: enumOf(WEIGHT_HISTORIES),
      fastingReason: enumOf(FASTING_REASONS),
      mealWindow: timeWindow,
      planCode: planCodeSchema,
      healthFlags: listOf(HEALTH_FLAGS),
      foodLoves: listOf(FOOD_LOVES, { minItems: 1 }),
      foodSkips: listOf(FOOD_SKIPS),
      obstacles: listOf(OBSTACLES),
      safetyAcknowledged: { type: 'boolean' },
    },
  },
  response: { 200: profileResponse(true) },
};

const notificationKeys = [
  'fasting',
  'streak',
  'weight',
  'water',
  'challenges',
  'world',
  'marketing',
];
const settingsSchema = {
  type: 'object',
  required: [
    'pushEnabled',
    'notifications',
    'waterReminderIntervalMin',
    'quietHours',
    'healthSyncEnabled',
  ],
  properties: {
    pushEnabled: { type: 'boolean' },
    notifications: {
      type: 'object',
      properties: Object.fromEntries(notificationKeys.map((k) => [k, { type: 'boolean' }])),
    },
    waterReminderIntervalMin: { type: 'integer' },
    quietHours: timeWindow,
    healthSyncEnabled: { type: 'boolean' },
    // Challenge katılımcı listesinde ad + avatar görünsün mü (açık rıza, varsayılan kapalı).
    showInChallenges: { type: 'boolean' },
  },
};

export const getSettingsSchema = {
  tags: ['user'],
  summary: 'Bildirim ve senkron ayarları',
  security: bearer,
  response: { 200: envelope(settingsSchema) },
};

export const patchSettingsSchema = {
  tags: ['user'],
  summary: 'Ayarları güncelle (kısmi)',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      pushEnabled: { type: 'boolean' },
      notifications: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: Object.fromEntries(notificationKeys.map((k) => [k, { type: 'boolean' }])),
      },
      waterReminderIntervalMin: { type: 'integer', minimum: 30, maximum: 480 },
      quietHours: timeWindow,
      healthSyncEnabled: { type: 'boolean' },
      showInChallenges: { type: 'boolean' },
    },
  },
  response: { 200: envelope(settingsSchema) },
};

const macroGoals = {
  kcalGoal: { type: ['integer', 'null'] },
  proteinGoalG: { type: ['integer', 'null'] },
  carbsGoalG: { type: ['integer', 'null'] },
  fatGoalG: { type: ['integer', 'null'] },
};
const goalsSchema = {
  type: 'object',
  properties: {
    waterGoalMl: { type: 'integer' },
    glassSizeMl: { type: 'integer' },
    customGlassSizes: { type: 'array', items: { type: 'integer' } },
    stepsGoal: { type: 'integer' },
    ...macroGoals,
    computed: { type: 'object', properties: macroGoals },
    sleepGoalMin: { type: 'integer' },
    bedtime: { type: 'string' },
    wakeTime: { type: 'string' },
  },
};

export const getGoalsSchema = {
  tags: ['user'],
  summary: 'Günlük hedefler (+ sunucu önerisi)',
  security: bearer,
  response: { 200: envelope(goalsSchema) },
};

const optionalInt = (min, max) => ({ type: ['integer', 'null'], minimum: min, maximum: max });
export const patchGoalsSchema = {
  tags: ['user'],
  summary: 'Hedefleri güncelle (null → sunucu önerisi)',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      waterGoalMl: { type: 'integer', minimum: 500, maximum: 6000 },
      glassSizeMl: { type: 'integer', minimum: 50, maximum: 2000 },
      customGlassSizes: {
        type: ['array', 'null'],
        maxItems: 5,
        items: { type: 'integer', minimum: 50, maximum: 2000 },
      },
      stepsGoal: { type: 'integer', minimum: 1000, maximum: 50000 },
      kcalGoal: optionalInt(800, 5000),
      proteinGoalG: optionalInt(0, 400),
      carbsGoalG: optionalInt(0, 800),
      fatGoalG: optionalInt(0, 400),
      sleepGoalMin: { type: 'integer', minimum: 180, maximum: 720 },
      bedtime: hhmm,
      wakeTime: hhmm,
    },
  },
  response: { 200: envelope(goalsSchema) },
};

const consentList = envelope({
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'version', 'granted', 'at'],
        properties: {
          type: { type: 'string' },
          version: { type: 'string' },
          granted: { type: 'boolean' },
          at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
});

export const listConsentsSchema = {
  tags: ['user'],
  summary: 'Rızaların güncel durumu',
  security: bearer,
  response: { 200: consentList },
};

export const postConsentSchema = {
  tags: ['user'],
  summary: 'Rıza ver / geri çek (yalnızca ekleme)',
  security: bearer,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'version', 'granted'],
    properties: {
      type: enumOf(CONSENT_TYPES),
      version: { type: 'string', minLength: 1, maxLength: 20 },
      granted: { type: 'boolean' },
      source: enumOf(['settings', 'prompt']),
    },
  },
  response: { 200: consentList },
};

const progressDto = {
  type: 'object',
  required: ['level', 'streakDays', 'completedFasts', 'xp'],
  properties: {
    level: { type: 'integer' },
    xp: { type: 'integer' },
    levelXp: { type: 'integer' },
    nextLevelXp: { type: 'integer' },
    streakDays: { type: 'integer' },
    bestStreak: { type: 'integer' },
    completedFasts: { type: 'integer' },
    totalFasts: { type: 'integer' },
    totalFastedMinutes: { type: 'integer' },
    longestFastMinutes: { type: 'integer' },
  },
};

export const progressSchema = {
  tags: ['user'],
  summary: 'Seviye, XP, seri, oruç sayaçları',
  security: bearer,
  response: { 200: envelope(progressDto) },
};

export const userStatsSchema = {
  tags: ['user'],
  summary: 'Profil istatistikleri (aralık)',
  security: bearer,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { range: { ...enumOf(['week', 'month', 'year', 'all']), default: 'all' } },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        range: { type: 'string' },
        from: { type: ['string', 'null'] },
        to: { type: 'string' },
        ...statsTotalsSchema,
        currentStreak: { type: 'integer' },
        bestStreak: { type: 'integer' },
        weightChangeKg: { type: ['number', 'null'] },
        waterGoalDays: { type: 'integer' },
        mealsLogged: { type: 'integer' },
      },
    }),
  },
};

const nullableNumber = { type: ['number', 'null'] };

export const summarySchema = {
  tags: ['user'],
  summary: 'Ana sayfa tek çağrı (profil başlığı, aktif oruç, hafta, bugün)',
  security: bearer,
  response: {
    200: envelope({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: ['string', 'null'] },
            avatarUrl: { type: ['string', 'null'] },
            isPremium: { type: 'boolean' },
            isGuest: { type: 'boolean' },
            units: unitsSchema,
          },
        },
        progress: progressDto,
        activeFast: { ...fastSchema, type: ['object', 'null'] },
        eatingWindow: eatingWindowSchema,
        plan: userPlanSchema,
        pendingPlanCode: { type: ['string', 'null'] },
        week: { type: 'array', items: weekDaySchema },
        today: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            water: {
              type: 'object',
              properties: { ml: { type: 'integer' }, goalMl: { type: ['integer', 'null'] } },
            },
            steps: {
              type: 'object',
              properties: { count: { type: 'integer' }, goal: { type: ['integer', 'null'] } },
            },
            sleep: {
              type: 'object',
              properties: {
                minutes: { type: 'integer' },
                goalMin: { type: ['integer', 'null'] },
              },
            },
            nutrition: {
              type: 'object',
              properties: { kcal: { type: 'integer' }, kcalGoal: { type: ['integer', 'null'] } },
            },
            lastMeal: {
              type: ['object', 'null'],
              properties: {
                id: { type: 'string' },
                eatenAt: { type: 'string' },
                kind: { type: ['string', 'null'] },
                dietType: { type: ['string', 'null'] },
                feeling: { type: ['string', 'null'] },
                title: { type: ['string', 'null'] },
                kcal: { type: ['integer', 'null'] },
              },
            },
            hunger: {
              type: 'object',
              properties: { physical: { type: 'integer' }, emotional: { type: 'integer' } },
            },
          },
        },
        weight: {
          type: 'object',
          properties: {
            currentKg: nullableNumber,
            startKg: nullableNumber,
            goalKg: nullableNumber,
            progress: nullableNumber,
          },
        },
        featuredChallenge: challengeSchema,
        unreadNotifications: { type: 'integer' },
        serverTime: { type: 'string' },
      },
    }),
  },
};
