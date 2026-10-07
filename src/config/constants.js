/** Uygulamanın desteklediği diller (Flutter `assets/translations` ile aynı). */
export const SUPPORTED_LOCALES = ['en', 'tr', 'de', 'es', 'fr', 'it', 'ru'];

export const DEFAULT_LOCALE = 'en';

export const PLATFORMS = ['ios', 'android'];

/** İstemcinin gönderdiği standart header'lar (docs/backend/02-mimari.md §4.3). */
export const HEADERS = Object.freeze({
  requestId: 'x-request-id',
  timezone: 'x-timezone',
  appVersion: 'x-app-version',
  platform: 'x-platform',
  installId: 'x-install-id',
  idempotencyKey: 'idempotency-key',
});

/** API sürüm öneki. */
export const API_PREFIX = '/v1';

/** İş kuyruğu adları (`jobs.queue`). Yeni kuyruklar fazlarla eklenir. */
export const QUEUES = Object.freeze({
  system: 'system',
  stats: 'stats',
});

/** Cache anahtar ad alanları (docs/backend/07-cache-performans.md §3). */
export const CACHE_NAMESPACES = Object.freeze({
  catalog: 'cat',
  config: 'cfg',
  user: 'u',
});

/**
 * Profil/onboarding enum'ları — API değerleri (lowerCamelCase). DB'de snake_case saklanır
 * (shared/enums.js ile çevrilir). docs/backend/01-uygulama-analizi.md §2.1, 04-api.md "Enum eşlemesi".
 */
export const GOALS = ['loseWeight', 'buildHabit', 'moreEnergy', 'gutReset'];
export const GENDERS = ['woman', 'man', 'nonBinary', 'preferNotToSay'];
export const DIETS = [
  'everything',
  'vegetarian',
  'pescatarian',
  'vegan',
  'lowCarb',
  'mediterranean',
];
export const WEIGHT_HISTORIES = ['manyTimes', 'onceOrTwice', 'firstTime'];
export const OBSTACLES = [
  'tooRestrictive',
  'lostMotivation',
  'noTimeToCook',
  'tooConfusing',
  'lifeGotBusy',
  'hitPlateau',
];
export const FASTING_REASONS = ['specialDate', 'trip', 'healthLongevity', 'confidence'];
export const FOOD_LOVES = [
  'chicken',
  'fish',
  'rice',
  'redMeat',
  'pasta',
  'salads',
  'cheese',
  'eggs',
  'spicy',
  'noodles',
  'fruit',
  'avocado',
  'sweets',
];
export const FOOD_SKIPS = [
  'mushrooms',
  'olives',
  'seafood',
  'onions',
  'broccoli',
  'tooSpicy',
  'dairy',
  'nuts',
  'beans',
  'eggplant',
];
/** İstemcinin bildirebileceği sağlık durumları. `under_18` yaştan türetilir, istemciden gelmez. */
export const HEALTH_FLAGS = [
  'pregnant',
  'breastfeeding',
  'eatingDisorderHistory',
  'diabetes',
  'medication',
  'heartCondition',
];
export const CONSENT_TYPES = [
  'terms',
  'privacy',
  'healthData',
  'aiProcessing',
  'marketingPush',
  'analytics',
];
export const UNITS = Object.freeze({
  weight: ['kg', 'lb'],
  height: ['cm', 'ftIn'],
  water: ['ml', 'oz'],
});
