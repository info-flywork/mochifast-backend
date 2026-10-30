import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Flutter uygulamasının çevirilerinden (assets/translations/*.json) içerik seed'lerini üretir:
 *   seeds/content.json         evreler, zorlanma, Insights, SSS, sıralı listeler (görsel/gün/renk)
 *   seeds/content_labels.json  onboarding seçenekleri, plan rozetleri, sohbet önerileri metinleri
 *
 *   node scripts/extract-translations.js [--app ../fastingapp]
 *
 * Metinler uygulamadan gelir (7 dil elle kopyalanmaz). Metin dışı yapı (saatler, görseller,
 * sebep→ipucu eşleşmesi, renkler) uygulamanın bugünkü ekran kodundan alınmıştır ve AŞAĞIDA
 * sabittir; görseller AppImages adıyla verilir, mantıksal yola (assets/images/…png) çevrilir.
 */

const LOCALES = ['en', 'tr', 'de', 'es', 'fr', 'it', 'ru', 'pt', 'ko', 'hi', 'zh', 'ja'];
const argApp = process.argv.indexOf('--app');
const APP = path.resolve(argApp > -1 ? process.argv[argApp + 1] : '../fastingapp');
const OUT = new URL('../seeds/', import.meta.url);

const missing = [];
const translations = {};
for (const l of LOCALES) {
  translations[l] = JSON.parse(await readFile(`${APP}/assets/translations/${l}.json`, 'utf8'));
}
const imagesSrc = await readFile(`${APP}/lib/generated/app_images.g.dart`, 'utf8');
const images = Object.fromEntries(
  [...imagesSrc.matchAll(/static const AppImageAsset (\w+) =\s*AppImageAsset\('([^']+)'\)/g)].map(
    (m) => [m[1], m[2]],
  ),
);
const colorsSrc = await readFile(`${APP}/lib/generated/colors.gen.dart`, 'utf8');
const colors = Object.fromEntries(
  [...colorsSrc.matchAll(/static const Color (\w+) = Color\(0x([0-9A-Fa-f]{8})\)/g)].map((m) => [
    m[1],
    m[2].toUpperCase(),
  ]),
);

function img(name) {
  if (!images[name]) throw new Error(`AppImages.${name} yok (lib/generated/app_images.g.dart)`);
  return images[name];
}

/** ColorName → '#RRGGBB' (opak) ya da '#RRGGBBAA'. `alpha` 0–1 verilirse ezer. */
function color(name, alpha) {
  const argb = colors[name];
  if (!argb) throw new Error(`ColorName.${name} yok`);
  const a =
    alpha === undefined
      ? argb.slice(0, 2)
      : Math.round(alpha * 255)
          .toString(16)
          .padStart(2, '0');
  return `#${argb.slice(2)}${a.toUpperCase() === 'FF' ? '' : a.toUpperCase()}`;
}

function lookup(locale, key) {
  return key
    .split('.')
    .reduce(
      (node, k) => (node === null || node === undefined ? undefined : node[k]),
      translations[locale],
    );
}

/** `{ en: …, tr: … }` — bir dilde yoksa o dil atlanır (sorguda en'e düşer). */
function t(key) {
  const out = {};
  for (const l of LOCALES) {
    const v = lookup(l, key);
    if (typeof v === 'string' && v.trim()) out[l] = v;
    else missing.push(`${l}:${key}`);
  }
  if (!out.en) throw new Error(`İngilizce metin yok: ${key}`);
  return out;
}

/** Birden çok alanı dil bazında birleştirir: { en: { title, body }, … } */
function fields(map) {
  const out = {};
  for (const [field, key] of Object.entries(map)) {
    if (key === null || key === undefined) continue;
    for (const [l, v] of Object.entries(t(key))) (out[l] ??= {})[field] = v;
  }
  return out;
}

// ── Evreler ───────────────────────────────────────────────────────────
const BODY_HOURS = [0, 2, 5, 8, 12, 16, 18, 24, 48, null];
const stages = [
  ...Array.from({ length: 9 }, (_, i) => ({
    type: 'body',
    position: i + 1,
    startHour: BODY_HOURS[i],
    endHour: BODY_HOURS[i + 1],
    imageKey: `a${i + 1}`,
    imageIdle: img(`a${i + 1}`),
    imageReached: img(`a${i + 1}Light`),
    translations: fields({
      rangeLabel: `body_status.range_${i + 1}`,
      title: `body_status.title_${i + 1}`,
      body: `body_status.body_${i + 1}`,
    }),
  })),
  ...[
    ['break', 'breakYourFast', 'breakYourFast'],
    ['nourish', 'keepNoruish', 'darkNorusih'],
    ['next', 'nextFast', 'darkFast'],
  ].map(([key, reached, idle], i) => ({
    type: 'eating_window',
    position: i + 1,
    startHour: null,
    endHour: null,
    imageKey: key,
    imageIdle: img(idle),
    imageReached: img(reached),
    translations: fields({
      title: `eating_window.${key}_title`,
      body: `eating_window.${key}_body`,
    }),
  })),
];

// ── Zorlanma ──────────────────────────────────────────────────────────
const S = 'fasting_struggle';
const struggle = {
  intro: fields({ title: `${S}.title`, body: `${S}.body` }),
  reasons: [
    ['hungry', 'hungry', ['hydration', 'walk']],
    ['craving', 'cravling', ['breathe']],
    ['energy', 'lowEnergiy', ['walk']],
    ['stressed', 'stressed', ['hydration', 'breathe']],
    ['bored', 'bored', ['hydration', 'walk', 'breathe']],
  ].map(([code, image, tips], i) => ({
    code,
    image: img(image),
    tips,
    sortOrder: i + 1,
    translations: fields({ title: `${S}.${code}_title`, body: `${S}.${code}_body` }),
  })),
  tips: [
    {
      code: 'hydration',
      image: img('blob'),
      activity: { type: 'sips', sips: 8 },
      keys: { session: 'sip_title', sessionBody: 'sip_hint', done: 'sip_done' },
    },
    {
      code: 'walk',
      image: img('quickWalk'),
      activity: { type: 'timer', seconds: 180 },
      keys: { session: 'walk_session_title', sessionBody: 'walk_session_body', done: 'walk_done' },
    },
    {
      code: 'breathe',
      image: img('breathe'),
      activity: { type: 'breathing', inhale: 4, hold: 7, exhale: 8, rounds: 4 },
      keys: {
        session: 'breathe_session_title',
        sessionBody: 'breathe_session_body',
        done: 'breathe_done',
      },
    },
  ].map(({ code, image, activity, keys }, i) => ({
    code,
    image,
    activity,
    sortOrder: i + 1,
    translations: fields({
      title: `${S}.${code}_title`,
      body: `${S}.${code}_body`,
      sessionTitle: `${S}.${keys.session}`,
      sessionBody: `${S}.${keys.sessionBody}`,
      doneTitle: `${S}.${keys.done}_title`,
      doneBody: `${S}.${keys.done}_body`,
      doneButton: `${S}.${keys.done}_button`,
    }),
  })),
};

// ── Insights ──────────────────────────────────────────────────────────
const ICON_IMAGES = {
  tree: 'tree',
  flame: 'flameCalories',
  window: 'eatWindow',
  heart: 'blueHearth',
  star: 'purpleStar',
};
const INSIGHTS = [
  [
    'basics',
    'tree',
    color('colorOptionSelected', 0.2),
    'what-is-intermittent-fasting',
    ['tree', 'flame', 'window'],
  ],
  [
    'during',
    'flame',
    color('colorInsightDuring'),
    'what-happens-while-you-fast',
    ['flame', 'heart', 'tree'],
  ],
  [
    'eating',
    'window',
    color('colorInsightEating'),
    'how-to-use-your-eating-window',
    ['window', 'flame', 'tree'],
  ],
  [
    'health',
    'heart',
    color('colorInsightHealth'),
    'fasting-and-everyday-life',
    ['heart', 'flame', 'tree'],
  ],
  ['tips', 'star', color('colorInsightTips'), 'mochis-tips', ['star', 'tree', 'flame']],
];
const words = (s) => s.split(/\s+/).filter(Boolean).length;
const insights = {
  categories: INSIGHTS.map(([slug, icon, bg], i) => ({
    slug,
    icon,
    iconImage: img(ICON_IMAGES[icon]),
    bgColor: bg,
    isPremium: false,
    sortOrder: i + 1,
    translations: fields({
      title: `insights_page.${slug}_title`,
      description: `insights_page.${slug}_body`,
    }),
  })),
  articles: INSIGHTS.map(([category, , , slug, sectionIcons], i) => {
    const p = `insights_detail.${category}`;
    const article = {
      slug,
      category,
      isPremium: false,
      sortOrder: i + 1,
      translations: fields({
        kicker: `${p}.kicker`,
        title: `${p}.title`,
        subtitle: `${p}.subtitle`,
        quote: `${p}.quote`,
        quoteAuthor: 'insights_detail.author',
        tip: `${p}.tip`,
      }),
      sections: sectionIcons.map((icon, s) => ({
        position: s + 1,
        icon,
        iconImage: img(ICON_IMAGES[icon]),
        translations: fields({ title: `${p}.card${s + 1}_title`, body: `${p}.card${s + 1}_body` }),
      })),
    };
    const en = [article.translations.en, ...article.sections.map((s) => s.translations.en)]
      .flatMap((o) => Object.values(o))
      .join(' ');
    article.readMinutes = Math.max(1, Math.ceil(words(en) / 200));
    return article;
  }),
};

// ── SSS ───────────────────────────────────────────────────────────────
const faq = ['what', 'start', 'beginner', 'premium', 'history', 'cancel'].map((code, i) => ({
  code,
  sortOrder: i + 1,
  translations: fields({ question: `faq.q_${code}`, answer: `faq.a_${code}` }),
}));

// ── Sıralı listeler + metinleri (catalog_items + catalog_labels) ──────
const O = 'onboarding';
const items = {};
const labels = {};
function list(namespace, entries) {
  items[namespace] = entries.map((e, i) => ({
    code: e.code,
    sortOrder: i + 1,
    data: e.data ?? null,
  }));
  labels[namespace] = {};
  for (const e of entries) {
    for (const [field, key] of Object.entries(e.text)) {
      labels[namespace][field === '' ? e.code : `${e.code}.${field}`] = t(key);
    }
  }
}
const option = (code, image, text, extra = {}) => ({
  code,
  data: { image: img(image), ...extra },
  text,
});

list('goal', [
  option('lose_weight', 'weigher', {
    title: `${O}.goal_lose_weight_title`,
    subtitle: `${O}.goal_lose_weight_subtitle`,
    badge: `${O}.most_popular`,
  }),
  option('build_habit', 'plant', {
    title: `${O}.goal_build_habit_title`,
    subtitle: `${O}.goal_build_habit_subtitle`,
  }),
  option('more_energy', 'greenApple', {
    title: `${O}.goal_more_energy_title`,
    subtitle: `${O}.goal_more_energy_subtitle`,
  }),
  option('gut_reset', 'bowel', {
    title: `${O}.goal_gut_reset_title`,
    subtitle: `${O}.goal_gut_reset_subtitle`,
  }),
]);
list('gender', [
  option('woman', 'woman', { title: `${O}.gender_woman` }),
  option('man', 'man', { title: `${O}.gender_man` }),
  option('non_binary', 'nonBinary', { title: `${O}.gender_non_binary` }),
  option('prefer_not_to_say', 'preferNot', { title: `${O}.gender_prefer_not` }),
]);
list(
  'diet',
  [
    ['everything', 'everything'],
    ['vegetarian', 'vegetarian'],
    ['pescatarian', 'pescatarian'],
    ['vegan', 'plant'],
    ['low_carb', 'lawCarb'],
    ['mediterranean', 'mediterrian'],
  ].map(([code, image]) =>
    option(code, image, {
      title: `${O}.diet_${code}_title`,
      subtitle: `${O}.diet_${code}_subtitle`,
    }),
  ),
);
list(
  'food_love',
  [
    ['chicken', 'chicken'],
    ['fish', 'fish'],
    ['rice', 'rice'],
    ['red_meat', 'meat'],
    ['pasta', 'pasta'],
    ['salads', 'salata'],
    ['cheese', 'cheese'],
    ['eggs', 'eggs'],
    ['spicy', 'spicy'],
    ['noodles', 'noodles'],
    ['fruit', 'fruit'],
    ['avocado', 'avacado'],
    ['sweets', 'sweethies'],
  ].map(([code, image]) => option(code, image, { title: `${O}.food_${code}` })),
);
list(
  'food_skip',
  [
    ['mushrooms', 'mushroom'],
    ['olives', 'olives'],
    ['seafood', 'seefood'],
    ['onions', 'onion'],
    ['broccoli', 'brocolies'],
    ['too_spicy', 'toospicy'],
    ['dairy', 'dairy'],
    ['nuts', 'nuts'],
    ['beans', 'beans'],
    ['eggplant', 'eggplant'],
  ].map(([code, image]) => option(code, image, { title: `${O}.food_skip_${code}` })),
);
list(
  'weight_history',
  [
    ['many_times', 'weigher', 'many'],
    ['once_or_twice', 'a1Or2', 'once'],
    ['first_time', 'plant', 'first'],
  ].map(([code, image, key]) =>
    option(code, image, {
      title: `${O}.weight_history_${key}_title`,
      subtitle: `${O}.weight_history_${key}_subtitle`,
    }),
  ),
);
list(
  'obstacle',
  [
    ['too_restrictive', 'restrictive', 'restrictive'],
    ['lost_motivation', 'motivation', 'motivation'],
    ['no_time_to_cook', 'timeCook', 'time_cook'],
    ['too_confusing', 'confusing', 'confusing'],
    ['life_got_busy', 'busy', 'busy'],
    ['hit_plateau', 'pleteu', 'plateau'],
  ].map(([code, image, key]) => option(code, image, { title: `${O}.obstacle_${key}` })),
);
list(
  'fasting_reason',
  [
    ['special_date', 'date', 'special_date', 45],
    ['trip', 'trip', 'trip', 90],
    ['health_longevity', 'healty', 'health', 180],
    ['confidence', 'confidence', 'confidence', 120],
  ].map(([code, image, key, days]) =>
    option(code, image, { title: `${O}.fasting_reason_${key}` }, { days }),
  ),
);
list(
  'onboarding_plan',
  [
    ['16_8', 'popular', 'colorPlanBadgePopular'],
    ['14_10', 'beginner', 'colorPlanBadgeBeginner'],
    ['18_6', 'steady', 'colorPlanBadgeSteady'],
    ['20_4', 'advanced', 'colorPlanBadgeAdvanced'],
    ['omad', 'pro', 'colorPlanBadgePro'],
    ['5_2', 'flexible', 'colorPlanBadgeFlexible'],
  ].map(([code, badge, badgeColor]) => ({
    code,
    data: { badgeColor: color(badgeColor) },
    text: {
      title: `${O}.plan_${code}_title`,
      subtitle: `${O}.plan_${code}_subtitle`,
      badge: `${O}.plan_badge_${badge}`,
    },
  })),
);
list(
  'chat_suggestion',
  ['hungry', 'coffee', 'weight', 'eat'].map((code) => ({
    code,
    text: { '': `chat.suggestion_${code}` },
  })),
);

// Açlık check-in önerileri (05 §5.2–5.3). Güvenlik önerisinin uygulamada metni yok; burada
// yazılır (güvenlik metni olduğu için çeviri kontrolü insan gözünden geçmeli).
list('hunger_rec', [
  ...[1, 2, 3].map((n) => ({
    code: `physical_${n}`,
    text: { '': `hunger_result_page.physical_rec_${n}` },
  })),
  ...[1, 2, 3, 4].map((n) => ({
    code: `emotional_${n}`,
    text: { '': `hunger_result_page.emotional_rec_${n}` },
  })),
]);
items.hunger_rec.push({ code: 'safety_end_fast', sortOrder: 0, data: { priority: true } });
labels.hunger_rec.safety_end_fast = {
  en: "If you don't feel well, it's completely okay to end your fast now.",
  tr: 'Kendini iyi hissetmiyorsan orucunu şimdi bitirmen tamamen normal.',
  de: 'Wenn du dich nicht gut fühlst, ist es völlig in Ordnung, dein Fasten jetzt zu beenden.',
  es: 'Si no te sientes bien, está totalmente bien terminar tu ayuno ahora.',
  fr: "Si tu ne te sens pas bien, c'est tout à fait normal d'arrêter ton jeûne maintenant.",
  it: 'Se non ti senti bene, va benissimo interrompere il digiuno adesso.',
  ru: 'Если ты плохо себя чувствуешь, совершенно нормально прервать голодание сейчас.',
  pt: 'Se não te sentires bem, é completamente normal terminares o jejum agora.',
  ko: '몸이 좋지 않으면 지금 단식을 끝내도 전혀 괜찮아요.',
  hi: 'अगर आप ठीक महसूस नहीं कर रहे, तो उपवास अभी खत्म करना बिल्कुल ठीक है।',
  zh: '如果感觉不舒服，现在结束断食完全没问题。',
  ja: '体調がよくないときは、今すぐ断食を終えて大丈夫です。',
};

const write = (name, data) => writeFile(new URL(name, OUT), `${JSON.stringify(data, null, 2)}\n`);
await write('content.json', { stages, struggle, insights, faq, items });
await write('content_labels.json', labels);

console.log(
  `✔ content: ${stages.length} evre, ${struggle.reasons.length} sebep, ${struggle.tips.length} ipucu, ` +
    `${insights.categories.length} kategori, ${insights.articles.length} makale, ${faq.length} SSS, ` +
    `${Object.keys(items).length} liste`,
);
if (missing.length) {
  console.log(
    `⚠ ${missing.length} çeviri eksik (en'e düşer): ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}`,
  );
}
