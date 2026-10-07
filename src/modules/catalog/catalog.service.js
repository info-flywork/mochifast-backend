import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../../config/constants.js';
import { toApiEnum } from '../../shared/enums.js';
import * as repo from './catalog.repository.js';

/** Plan ekranındaki grup sırası (ürün dokümanı "Önerilen Gruplama"). */
export const PLAN_GROUP_ORDER = [
  'beginner',
  'popular',
  'intermediate',
  'advanced',
  'weekly',
  'flexible',
];
const TIMING_ORDER = ['skip_breakfast', 'skip_dinner', 'early_window', 'late_window', 'custom'];

const CATALOG_TTL_SEC = 24 * 3600;
const CONFIG_TTL_SEC = 60;

/**
 * Katalog (planlar) ve uygulama yapılandırması (docs/backend/04-api.md §4, 07 §2).
 *
 * Cache: `cat:v{n}:…` anahtarları; `n` = app_config `catalog.version` (60 sn cache'li).
 * `npm run seed` sürümü artırır → en geç 60 sn sonra yeni katalog okunur, eski anahtarlar
 * LRU'dan düşer. Premium kilidi cache'lenmez, her istekte uygulanır.
 */
export function createCatalogService({ db, cache }) {
  const localeOf = (locale) => (SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE);

  async function configRows() {
    return cache.getOrSet('cfg:app:rows', CONFIG_TTL_SEC, async () =>
      (await repo.loadAppConfig(db)).map((r) => ({
        key: r.config_key,
        platform: r.platform,
        value: JSON.parse(r.value),
      })),
    );
  }

  async function version() {
    const rows = await configRows().catch(() => []);
    return rows.find((r) => r.key === 'catalog.version')?.value ?? 0;
  }

  /** Bir dilde planların kilitsiz, gruplanmamış hâli (cache'li). */
  async function plansFor(locale) {
    const v = await version();
    return cache.getOrSet(`cat:v${v}:plans:${locale}`, CATALOG_TTL_SEC, async () => ({
      plans: (await repo.loadPlans(db, locale)).map(toPlan),
      categories: await repo.loadLabels(db, 'plan_category', locale),
      timings: await repo.loadLabels(db, 'plan_timing', locale),
    }));
  }

  const service = {
    version,

    /**
     * GET /v1/catalog/plans: gruplar + zamanlama tercihleri.
     * @param options.hasPremium premium kullanıcıda kilit yok (F8'de entitlement'tan gelir)
     */
    async planCatalog(locale, { hasPremium = false } = {}) {
      const data = await plansFor(localeOf(locale));
      return {
        groups: PLAN_GROUP_ORDER.map((category) => ({
          category,
          title: data.categories[category] ?? category,
          plans: data.plans
            .filter((p) => p.groups.includes(category))
            .map((p) => summary(p, hasPremium)),
        })).filter((g) => g.plans.length > 0),
        timings: TIMING_ORDER.map((code) => ({
          code: toApiEnum(code),
          title: data.timings[code] ?? code,
        })),
      };
    },

    /** GET /v1/catalog/plans/:code. Bilinmeyen kod → null. */
    async planDetail(code, locale, { hasPremium = false } = {}) {
      const plan = (await plansFor(localeOf(locale))).plans.find((p) => p.code === code);
      if (!plan) return null;
      return {
        ...summary(plan, hasPremium),
        longDescription: plan.longDescription,
        safetyNote: plan.safetyNote,
        exampleWindow: exampleWindow(plan),
        weeklyTemplate: weeklyTemplate(plan),
      };
    },

    /** Kural motorları için dil bağımsız plan (onboarding, ileride plan seçimi). */
    async planRules(code) {
      const plan = (await plansFor(DEFAULT_LOCALE)).plans.find((p) => p.code === code);
      return plan
        ? {
            code: plan.code,
            category: plan.category,
            scheduleType: plan.scheduleType,
            fastHours: plan.fastHours,
            eatHours: plan.eatHours,
            minAge: plan.minAge,
            isPremium: plan.isPremium,
            requiresSafetyAck: plan.requiresSafetyAck,
            allowedTimings: plan.allowedTimings,
            defaultTiming: plan.defaultTiming,
            defaultEatStart: plan.defaultEatStart,
            reducedDaysPerWeek: plan.reducedDaysPerWeek,
            reducedDayKcal: plan.reducedDayKcal,
            weeklyTemplate: weeklyTemplate(plan),
          }
        : null;
    },

    /** Platforma göre birleşmiş yapılandırma (platforma özel değer 'all'ı ezer). */
    async appConfig(platform) {
      const rows = await configRows();
      const merged = {};
      for (const r of rows) if (r.platform === 'all') merged[r.key] = r.value;
      for (const r of rows) if (r.platform === platform) merged[r.key] = r.value;
      return merged;
    },
  };
  return service;
}

function toPlan(r) {
  return {
    code: r.code,
    category: r.category,
    groups: (r.groups_csv ?? r.category).split(','),
    scheduleType: r.schedule_type,
    fastHours: r.fast_hours,
    eatHours: r.eat_hours,
    reducedDaysPerWeek: r.reduced_days_per_week,
    reducedDayKcal: r.reduced_day_kcal,
    intensity: r.intensity,
    isPremium: Boolean(r.is_premium),
    isFeatured: Boolean(r.is_featured),
    minAge: r.min_age,
    requiresSafetyAck: Boolean(r.requires_safety_ack),
    defaultTiming: r.default_timing,
    defaultEatStart: r.default_eat_start ? String(r.default_eat_start).slice(0, 5) : null,
    allowedTimings: r.allowed_timings ? r.allowed_timings.split(',') : [],
    displayName: r.display_name,
    cardLabel: r.card_label,
    shortDescription: r.short_description,
    longDescription: r.long_description ?? null,
    safetyNote: r.safety_note ?? null,
  };
}

function summary(p, hasPremium) {
  return {
    code: p.code,
    category: p.category,
    scheduleType: toApiEnum(p.scheduleType),
    displayName: p.displayName,
    cardLabel: p.cardLabel,
    shortDescription: p.shortDescription,
    fastHours: p.fastHours,
    eatHours: p.eatHours,
    reducedDaysPerWeek: p.reducedDaysPerWeek,
    reducedDayKcal: p.reducedDayKcal,
    intensity: p.intensity,
    isPremium: p.isPremium,
    isLocked: p.isPremium && !hasPremium,
    isFeatured: p.isFeatured,
    requiresSafetyAck: p.requiresSafetyAck,
    minAge: p.minAge,
    allowedTimings: p.allowedTimings.map(toApiEnum),
    defaultTiming: toApiEnum(p.defaultTiming),
    defaultEatStart: p.defaultEatStart,
  };
}

/** Günlük planlarda örnek yeme penceresi: varsayılan başlangıç + yeme süresi. */
function exampleWindow(p) {
  if (!p.defaultEatStart || !p.eatHours) return null;
  const [h, m] = p.defaultEatStart.split(':').map(Number);
  const end = (h * 60 + m + Math.round(p.eatHours * 60)) % 1440;
  const pad = (n) => String(n).padStart(2, '0');
  return { start: p.defaultEatStart, end: `${pad(Math.floor(end / 60))}:${pad(end % 60)}` };
}

/**
 * Haftalık/özel planlarda 7 günlük başlangıç şablonu (dow: 1 = Pazartesi).
 * Azaltılmış günler ardışık olmaz (05 §2.2).
 */
function weeklyTemplate(p) {
  const days = (type) => Array.from({ length: 7 }, (_, i) => ({ dow: i + 1, type: type(i + 1) }));
  switch (p.scheduleType) {
    case 'weekly_reduced':
      return days((d) =>
        (p.reducedDaysPerWeek === 2 ? [1, 4] : [3]).includes(d) ? 'reduced' : 'normal',
      ).map((d) => (d.type === 'reduced' ? { ...d, kcal: p.reducedDayKcal } : d));
    case 'alternate_day':
      return days((d) => (d % 2 === 1 ? 'reduced' : 'normal')).map((d) =>
        d.type === 'reduced' ? { ...d, kcal: p.reducedDayKcal } : d,
      );
    case 'selected_days':
      return days((d) => ([1, 3, 5].includes(d) ? 'fast' : 'normal')).map((d) =>
        d.type === 'fast' ? { ...d, fastMinutes: Math.round(p.fastHours * 60) } : d,
      );
    case 'custom_weekly':
      return days(() => 'fast').map((d) => ({ ...d, fastMinutes: 16 * 60 }));
    default:
      return null;
  }
}
