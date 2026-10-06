import { envelope, pagedEnvelope, pageQuerySchema } from '../../shared/schemas.js';
import { planSummarySchema } from './catalog.schemas.js';

const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
const items = (schema) =>
  envelope({
    type: 'object',
    required: ['items'],
    properties: { items: { type: 'array', items: schema } },
  });

export const stagesSchema = {
  tags: ['catalog'],
  summary: 'Vücut evreleri ya da yeme penceresi evreleri',
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['body', 'eating_window', 'eatingWindow'], default: 'body' },
    },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        type: str,
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              position: { type: 'integer' },
              startHour: { type: ['number', 'null'] },
              endHour: { type: ['number', 'null'] },
              rangeLabel: nstr,
              title: str,
              body: str,
              imageKey: str,
              images: { type: 'object', properties: { idle: nstr, reached: nstr } },
            },
          },
        },
      },
    }),
  },
};

export const struggleSchema = {
  tags: ['catalog'],
  summary: 'Zorlanma: sebepler, önerilen ipuçları ve etkinlikleri',
  response: {
    200: envelope({
      type: 'object',
      properties: {
        intro: { type: 'object', properties: { title: str, body: str } },
        reasons: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: str,
              title: str,
              body: str,
              image: str,
              tips: { type: 'array', items: str },
            },
          },
        },
        tips: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: str,
              title: str,
              body: str,
              image: str,
              activity: { type: 'object', additionalProperties: true },
              session: { type: 'object', properties: { title: nstr, body: nstr } },
              done: { type: 'object', properties: { title: nstr, body: nstr, button: nstr } },
            },
          },
        },
      },
    }),
  },
};

export const faqSchema = {
  tags: ['catalog'],
  summary: 'Sıkça sorulan sorular',
  response: {
    200: items({ type: 'object', properties: { code: str, question: str, answer: str } }),
  },
};

export const chatSuggestionsSchema = {
  tags: ['catalog'],
  summary: 'Sohbet ekranındaki hazır öneriler',
  response: { 200: items({ type: 'object', properties: { code: str, text: str } }) },
};

const option = {
  type: 'object',
  properties: {
    code: str,
    title: str,
    subtitle: str,
    badge: str,
    image: str,
    days: { type: 'integer' },
  },
};
const optionList = { type: 'array', items: option };

export const onboardingOptionsSchema = {
  tags: ['catalog'],
  summary: 'Onboarding seçenekleri (uzaktan güncellenebilir listeler + plan kartları)',
  response: {
    200: envelope({
      type: 'object',
      properties: {
        goals: optionList,
        genders: optionList,
        diets: optionList,
        foodLoves: optionList,
        foodSkips: optionList,
        weightHistories: optionList,
        obstacles: optionList,
        fastingReasons: optionList,
        plans: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ...planSummarySchema.properties,
              title: str,
              subtitle: str,
              badge: nstr,
              badgeColor: nstr,
            },
          },
        },
      },
    }),
  },
};

const categoryItem = {
  type: 'object',
  properties: {
    slug: str,
    title: str,
    description: str,
    icon: str,
    iconImage: nstr,
    bgColor: str,
    isPremium: { type: 'boolean' },
    isLocked: { type: 'boolean' },
    articleCount: { type: 'integer' },
  },
};

const articleSummary = {
  type: 'object',
  properties: {
    slug: str,
    category: str,
    kicker: str,
    title: str,
    subtitle: nstr,
    readMinutes: { type: ['integer', 'null'] },
    isPremium: { type: 'boolean' },
    isLocked: { type: 'boolean' },
  },
};

export const insightCategoriesSchema = {
  tags: ['insights'],
  summary: 'Insights kategorileri',
  response: { 200: items(categoryItem) },
};

export const insightArticlesSchema = {
  tags: ['insights'],
  summary: 'Makaleler (kategori süzgeci, arama, sayfalama)',
  querystring: {
    ...pageQuerySchema,
    properties: {
      ...pageQuerySchema.properties,
      category: { type: 'string', maxLength: 40 },
      q: { type: 'string', maxLength: 100 },
    },
  },
  response: { 200: pagedEnvelope(articleSummary) },
};

export const insightArticleSchema = {
  tags: ['insights'],
  summary: 'Makale (bölümleriyle)',
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['slug'],
    properties: { slug: { type: 'string', pattern: '^[a-z0-9-]{1,80}$' } },
  },
  response: {
    200: envelope({
      type: 'object',
      properties: {
        ...articleSummary.properties,
        quote: nstr,
        quoteAuthor: nstr,
        tip: nstr,
        publishedAt: nstr,
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              position: { type: 'integer' },
              icon: str,
              iconImage: nstr,
              title: str,
              body: str,
            },
          },
        },
      },
    }),
  },
};
