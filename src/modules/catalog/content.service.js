import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../../config/constants.js';
import { toApiEnum } from '../../shared/enums.js';
import { AppError } from '../../shared/errors.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination.js';
import * as labelsRepo from './catalog.repository.js';
import * as repo from './content.repository.js';

const TTL_SEC = 24 * 3600;
const INSIGHTS_TTL_SEC = 3600;

/** Onboarding seçenek listeleri: catalog_items/labels ad alanı → yanıt alanı. */
const ONBOARDING_LISTS = [
  ['goal', 'goals'],
  ['gender', 'genders'],
  ['diet', 'diets'],
  ['food_love', 'foodLoves'],
  ['food_skip', 'foodSkips'],
  ['weight_history', 'weightHistories'],
  ['obstacle', 'obstacles'],
  ['fasting_reason', 'fastingReasons'],
];

/**
 * İçerik katalogları (docs/backend/04-api.md §4): evreler, zorlanma, SSS, onboarding
 * seçenekleri, sohbet önerileri, Insights. Dil başına önbellek; anahtar katalog sürümünü
 * içerir (`npm run seed` sonrası yenilenir).
 */
export function createContentService({ db, cache, catalog }) {
  const localeOf = (l) => (SUPPORTED_LOCALES.includes(l) ? l : DEFAULT_LOCALE);
  const cached = async (key, ttl, loader) =>
    cache.getOrSet(`cat:v${await catalog.version()}:${key}`, ttl, loader);

  async function list(namespace, locale) {
    return cached(`list:${namespace}:${locale}`, TTL_SEC, async () => {
      const [items, labels] = await Promise.all([
        repo.loadItems(db, namespace),
        labelsRepo.loadLabels(db, namespace, locale),
      ]);
      return items.map((i) => ({
        code: i.code,
        data: i.data ? JSON.parse(i.data) : {},
        labels: pick(labels, i.code),
      }));
    });
  }

  async function insights(locale) {
    return cached(`insights:${locale}`, INSIGHTS_TTL_SEC, async () => {
      const { categories, articles, sections } = await repo.loadInsights(db, locale);
      const slugById = Object.fromEntries(categories.map((c) => [c.id, c.slug]));
      return {
        categories: categories.map((c) => ({
          slug: c.slug,
          title: c.title,
          description: c.description,
          icon: c.icon_key,
          iconImage: c.icon_image,
          bgColor: c.bg_color,
          isPremium: Boolean(c.is_premium),
          articleCount: articles.filter((a) => a.category_id === c.id).length,
        })),
        articles: articles
          .filter((a) => slugById[a.category_id])
          .map((a) => ({
            slug: a.slug,
            category: slugById[a.category_id],
            kicker: a.kicker,
            title: a.title,
            subtitle: a.subtitle ?? null,
            quote: a.quote ?? null,
            quoteAuthor: a.quote_author ?? null,
            tip: a.tip ?? null,
            readMinutes: a.read_minutes ?? null,
            isPremium: Boolean(a.is_premium),
            publishedAt: a.published_at ? a.published_at.toISOString() : null,
            sortOrder: a.sort_order,
            searchText: a.search_text,
            sections: sections
              .filter((s) => s.article_id === a.id)
              .map((s) => ({
                position: s.position,
                icon: s.icon_key,
                iconImage: s.icon_image,
                title: s.title,
                body: s.body,
              })),
          })),
      };
    });
  }

  return {
    async stages(type, rawLocale) {
      const locale = localeOf(rawLocale);
      const items = await cached(`stages:${type}:${locale}`, TTL_SEC, async () =>
        (await repo.loadStages(db, type, locale)).map((s) => ({
          position: s.position,
          startHour: s.start_hour,
          endHour: s.end_hour,
          rangeLabel: s.range_label ?? null,
          title: s.title,
          body: s.body,
          imageKey: s.image_key,
          images: { idle: s.image_idle, reached: s.image_reached },
        })),
      );
      return { type: toApiEnum(type), items };
    },

    async struggle(rawLocale) {
      const locale = localeOf(rawLocale);
      return cached(`struggle:${locale}`, TTL_SEC, async () => {
        const { reasons, tips, texts } = await repo.loadStruggle(db, locale);
        const text = (type, code) =>
          texts.find((t) => t.entity_type === type && t.code === code && t.locale === locale) ??
          texts.find((t) => t.entity_type === type && t.code === code);
        const intro = text('intro', 'intro');
        return {
          intro: { title: intro?.title ?? '', body: intro?.body ?? '' },
          reasons: reasons.map((r) => ({
            code: r.code,
            title: text('reason', r.code)?.title ?? r.code,
            body: text('reason', r.code)?.body ?? '',
            image: r.image,
            tips: JSON.parse(r.tips),
          })),
          tips: tips.map((t) => {
            const tr = text('tip', t.code) ?? {};
            return {
              code: t.code,
              title: tr.title ?? t.code,
              body: tr.body ?? '',
              image: t.image,
              activity: JSON.parse(t.activity),
              session: { title: tr.session_title ?? null, body: tr.session_body ?? null },
              done: {
                title: tr.done_title ?? null,
                body: tr.done_body ?? null,
                button: tr.done_button ?? null,
              },
            };
          }),
        };
      });
    },

    async faq(rawLocale) {
      const locale = localeOf(rawLocale);
      return { items: await cached(`faq:${locale}`, TTL_SEC, () => repo.loadFaq(db, locale)) };
    },

    async chatSuggestions(rawLocale) {
      const items = await list('chat_suggestion', localeOf(rawLocale));
      return { items: items.map((i) => ({ code: i.code, text: i.labels[''] ?? i.code })) };
    },

    /** Açlık check-in öneri metinleri (05 §5.2): `{ code: text }`. */
    async hungerRecommendations(rawLocale) {
      const items = await list('hunger_rec', localeOf(rawLocale));
      return Object.fromEntries(items.map((i) => [i.code, i.labels[''] ?? i.code]));
    },

    /** Onboarding ekranlarının listeleri + onboarding'de gösterilen plan kartları. */
    async onboardingOptions(rawLocale, { hasPremium = false } = {}) {
      const locale = localeOf(rawLocale);
      const out = {};
      for (const [namespace, field] of ONBOARDING_LISTS) {
        out[field] = (await list(namespace, locale)).map((i) => ({
          code: toApiEnum(i.code),
          title: i.labels.title ?? i.code,
          ...(i.labels.subtitle ? { subtitle: i.labels.subtitle } : {}),
          ...(i.labels.badge ? { badge: i.labels.badge } : {}),
          ...(i.data.image ? { image: i.data.image } : {}),
          ...(i.data.days ? { days: i.data.days } : {}),
        }));
      }
      const catalogPlans = (await catalog.planCatalog(locale, { hasPremium })).groups.flatMap(
        (g) => g.plans,
      );
      out.plans = (await list('onboarding_plan', locale))
        .map((i) => {
          const plan = catalogPlans.find((p) => p.code === i.code);
          return (
            plan && {
              ...plan,
              title: i.labels.title ?? plan.displayName,
              subtitle: i.labels.subtitle ?? plan.shortDescription,
              badge: i.labels.badge ?? null,
              badgeColor: i.data.badgeColor ?? null,
            }
          );
        })
        .filter(Boolean);
      return out;
    },

    async insightCategories(rawLocale, { hasPremium = false } = {}) {
      const { categories } = await insights(localeOf(rawLocale));
      return {
        items: categories.map((c) => ({ ...c, isLocked: c.isPremium && !hasPremium })),
      };
    },

    /**
     * Makale listesi: kategori süzgeci, arama (`q`: tüm kelimeler başlık/bölümlerde geçmeli,
     * büyük/küçük harf ve dil duyarlı), imleçli sayfalama.
     */
    async insightArticles(
      rawLocale,
      { category, q, limit = 20, cursor },
      { hasPremium = false } = {},
    ) {
      const locale = localeOf(rawLocale);
      const { articles } = await insights(locale);
      // Her terim bir kelimenin BAŞINDA geçmeli ("su" → "su", "suyu"; "sunum"un içindeki değil).
      const terms = (q ?? '')
        .toLocaleLowerCase(locale)
        .split(/\s+/)
        .filter((w) => w.length >= 2)
        .map((w) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(w)}`, 'u'));
      const matching = articles.filter(
        (a) => (!category || a.category === category) && terms.every((re) => re.test(a.searchText)),
      );
      const after = decodeCursor(cursor, ['o', 's']);
      const start = after
        ? matching.findIndex(
            (a) => a.sortOrder > after.o || (a.sortOrder === after.o && a.slug > after.s),
          )
        : 0;
      const pageRows = start === -1 ? [] : matching.slice(start, start + limit + 1);
      const hasMore = pageRows.length > limit;
      const items = pageRows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((a) => ({
          slug: a.slug,
          category: a.category,
          kicker: a.kicker,
          title: a.title,
          subtitle: a.subtitle,
          readMinutes: a.readMinutes,
          isPremium: a.isPremium,
          isLocked: a.isPremium && !hasPremium,
        })),
        pageInfo: {
          nextCursor: hasMore && last ? encodeCursor({ o: last.sortOrder, s: last.slug }) : null,
          hasMore,
        },
      };
    },

    async insightArticle(slug, rawLocale, { hasPremium = false } = {}) {
      const { articles } = await insights(localeOf(rawLocale));
      const a = articles.find((x) => x.slug === slug);
      if (!a) throw new AppError('NOT_FOUND');
      const locked = a.isPremium && !hasPremium;
      if (locked) throw new AppError('PREMIUM_REQUIRED');
      const { searchText: _s, sortOrder: _o, ...article } = a;
      return { ...article, isLocked: false };
    },
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `{ "lose_weight.title": "…" }` → kod için `{ title, subtitle, … }` ('' = tek metin). */
function pick(labels, code) {
  const out = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key === code) out[''] = value;
    else if (key.startsWith(`${code}.`)) out[key.slice(code.length + 1)] = value;
  }
  return out;
}
