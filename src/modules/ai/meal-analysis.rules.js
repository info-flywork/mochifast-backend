/**
 * Fotoğraf analizi çıktısı: şema ve sunucu tarafı doğrulama (docs/backend/09-yapay-zeka.md §3.2–3.3).
 * Modele körü körüne güvenilmez: sınırlar kırpılır, toplamlar ve makro tutarlılığı denetlenir.
 */

export const PROMPT_VERSION = 'meal_analysis.v1';

const LANGUAGES = {
  en: 'English',
  tr: 'Turkish',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  ru: 'Russian',
  pt: 'Portuguese',
  ko: 'Korean',
  hi: 'Hindi',
  zh: 'Simplified Chinese',
  ja: 'Japanese',
};
export const languageName = (locale) => LANGUAGES[locale] ?? LANGUAGES.en;

/**
 * Yapılandırılmış çıktı şeması. Sayısal ve uzunluk sınırları API'de desteklenmediği için
 * şemada yoktur; `normalizeAnalysis` uygular.
 */
const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'portion', 'kcal', 'proteinG', 'carbsG', 'fatG'],
  properties: {
    name: { type: 'string' },
    portion: { type: 'string' },
    kcal: { type: 'integer' },
    proteinG: { type: 'number' },
    carbsG: { type: 'number' },
    fatG: { type: 'number' },
  },
};

export const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'isFood',
    'mealTitle',
    'items',
    'kcal',
    'proteinG',
    'carbsG',
    'fatG',
    'confidence',
    'notes',
  ],
  properties: {
    isFood: { type: 'boolean' },
    mealTitle: { type: 'string' },
    items: { type: 'array', items: ITEM_SCHEMA },
    kcal: { type: 'integer' },
    proteinG: { type: 'number' },
    carbsG: { type: 'number' },
    fatG: { type: 'number' },
    confidence: { type: 'number' },
    notes: { type: 'string' },
  },
};

const MAX_ITEMS = 12;
const clamp = (v, min, max) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : 0));
const g = (v, max) => Math.round(clamp(v, 0, max) * 10) / 10;
const text = (v, max) =>
  String(v ?? '')
    .trim()
    .slice(0, max);
/** Kalemlerin toplamı ile verilen toplam arasında kabul edilen fark. */
const TOTAL_TOLERANCE = 0.1;
/** kcal ile makrolardan hesaplanan enerji (4P + 4C + 9F) arasında kabul edilen fark. */
const MACRO_TOLERANCE = 0.25;

/**
 * @returns `{ isFood, result }`. `result.flags`: uygulanan düzeltmeler (izleme ve eval için).
 */
export function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('analysis is not an object');
  if (raw.isFood !== true) return { isFood: false, result: null };

  const flags = [];
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, MAX_ITEMS).map((i) => ({
    name: text(i.name, 60),
    portion: text(i.portion, 30),
    kcal: Math.round(clamp(i.kcal, 0, 2500)),
    proteinG: g(i.proteinG, 250),
    carbsG: g(i.carbsG, 400),
    fatG: g(i.fatG, 250),
  }));

  let kcal = Math.round(clamp(raw.kcal, 0, 4000));
  let proteinG = g(raw.proteinG, 500);
  let carbsG = g(raw.carbsG, 800);
  let fatG = g(raw.fatG, 500);
  let confidence = Math.round(clamp(raw.confidence, 0, 1) * 100) / 100;
  const notes = text(raw.notes, 200);

  if (items.length > 0) {
    const sum = (k) => items.reduce((a, i) => a + i[k], 0);
    const itemsKcal = sum('kcal');
    const off = Math.abs(itemsKcal - kcal) / Math.max(kcal, itemsKcal, 1);
    if (off > TOTAL_TOLERANCE) {
      kcal = Math.min(itemsKcal, 4000);
      proteinG = g(sum('proteinG'), 500);
      carbsG = g(sum('carbsG'), 800);
      fatG = g(sum('fatG'), 500);
      flags.push('totals_recomputed');
    }
  }

  const macroKcal = 4 * proteinG + 4 * carbsG + 9 * fatG;
  if (kcal > 0 && Math.abs(kcal - macroKcal) / kcal > MACRO_TOLERANCE) {
    confidence = Math.min(confidence, 0.5);
    flags.push('macro_mismatch');
  }

  return {
    isFood: true,
    result: {
      mealTitle: text(raw.mealTitle, 80),
      items,
      kcal,
      proteinG,
      carbsG,
      fatG,
      confidence,
      notes,
      flags,
    },
  };
}
