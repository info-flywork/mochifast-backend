import { describe, expect, it } from 'vitest';
import { reasoningParam } from '../../src/infra/openai.js';
import { costMicroUsd, priceFor } from '../../src/modules/ai/ai.cost.js';
import { ANALYSIS_SCHEMA, normalizeAnalysis } from '../../src/modules/ai/meal-analysis.rules.js';

const meal = (overrides = {}) => ({
  isFood: true,
  mealTitle: 'Izgara tavuk ve fırın sebze',
  items: [
    { name: 'Izgara tavuk göğsü', portion: '150 g', kcal: 250, proteinG: 46, carbsG: 0, fatG: 6 },
    { name: 'Fırın sebze', portion: '1 kase', kcal: 300, proteinG: 6, carbsG: 40, fatG: 14 },
  ],
  kcal: 550,
  proteinG: 52,
  carbsG: 40,
  fatG: 20,
  confidence: 0.78,
  notes: '',
  ...overrides,
});

describe('analiz doğrulaması (09 §3.3)', () => {
  it('tutarlı sonuç olduğu gibi kalır', () => {
    const { isFood, result } = normalizeAnalysis(meal());
    expect(isFood).toBe(true);
    expect(result).toMatchObject({ kcal: 550, proteinG: 52, confidence: 0.78, flags: [] });
  });

  it('yemek değilse sonuç yok', () => {
    expect(normalizeAnalysis({ ...meal(), isFood: false })).toEqual({
      isFood: false,
      result: null,
    });
  });

  it("kalem toplamı %10'dan fazla saparsa toplamlar kalemlerden yeniden hesaplanır", () => {
    const { result } = normalizeAnalysis(meal({ kcal: 900, proteinG: 10, carbsG: 10, fatG: 10 }));
    expect(result).toMatchObject({ kcal: 550, proteinG: 52, carbsG: 40, fatG: 20 });
    expect(result.flags).toContain('totals_recomputed');
  });

  it('makro tutarsızlığında güven en fazla 0.5', () => {
    const { result } = normalizeAnalysis(
      meal({ items: [], kcal: 1000, proteinG: 10, carbsG: 10, fatG: 10, confidence: 0.9 }),
    );
    expect(result.confidence).toBe(0.5);
    expect(result.flags).toEqual(['macro_mismatch']);
  });

  it('sınırlar kırpılır: negatif/aşırı değerler, uzun metin, 12 kalem', () => {
    const items = Array.from({ length: 20 }, () => ({
      name: 'x'.repeat(100),
      portion: 'y'.repeat(50),
      kcal: -5,
      proteinG: 999,
      carbsG: 0,
      fatG: 0,
    }));
    const { result } = normalizeAnalysis(
      meal({ items, mealTitle: 'z'.repeat(200), kcal: 99999, confidence: 7 }),
    );
    expect(result.items).toHaveLength(12);
    expect(result.items[0]).toMatchObject({ kcal: 0, proteinG: 250 });
    expect(result.items[0].name).toHaveLength(60);
    expect(result.mealTitle).toHaveLength(80);
    expect(result.kcal).toBeLessThanOrEqual(4000);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('nesne olmayan çıktı reddedilir', () => {
    expect(() => normalizeAnalysis(null)).toThrow();
  });

  it('şema: yapılandırılmış çıktı kısıtları (tüm nesnelerde additionalProperties:false, sayı sınırı yok)', () => {
    expect(ANALYSIS_SCHEMA.additionalProperties).toBe(false);
    expect(ANALYSIS_SCHEMA.properties.items.items.additionalProperties).toBe(false);
    expect(JSON.stringify(ANALYSIS_SCHEMA)).not.toMatch(/minimum|maximum|maxLength|minLength/);
  });
});

describe('AI maliyeti', () => {
  it('maliyet: token × USD/MTok → mikro-USD', () => {
    const price = {
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 5,
    };
    const usage = {
      input_tokens: 1500,
      output_tokens: 400,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    };
    // 1500×4 + 400×20 + 1000×0.2 = 14200 µUSD = $0.0142
    expect(costMicroUsd(usage, price)).toBe(14200);
    expect(costMicroUsd(usage, undefined)).toBe(0);
  });

  it('fiyat: tarihli sürüm adı (OpenAI yanıtı) taban modelin fiyatını bulur; önek eşleşmez', () => {
    const pricing = { 'gpt-4o': { inputPerMTok: 2.5 }, 'gpt-4o-mini': { inputPerMTok: 0.15 } };
    expect(priceFor(pricing, 'gpt-4o')).toBe(pricing['gpt-4o']);
    expect(priceFor(pricing, 'gpt-4o-2024-08-06')).toBe(pricing['gpt-4o']);
    expect(priceFor(pricing, 'gpt-4o-mini-2024-07-18')).toBe(pricing['gpt-4o-mini']);
    expect(priceFor(pricing, 'gpt-4.1-2025-04-14')).toBeUndefined();
    expect(priceFor(pricing, 'gpt-4o-audio')).toBeUndefined();
    expect(priceFor(pricing, undefined)).toBeUndefined();
  });
});

describe('reasoningParam', () => {
  it('yalnızca reasoning modellerine gönderilir', () => {
    expect(reasoningParam('low', 'gpt-4o')).toEqual({});
    expect(reasoningParam('low', 'gpt-4o-2024-08-06')).toEqual({});
    expect(reasoningParam(null, 'gpt-5')).toEqual({});
    expect(reasoningParam('low', 'gpt-5-mini')).toEqual({ reasoning_effort: 'low' });
    expect(reasoningParam('high', 'o4-mini')).toEqual({ reasoning_effort: 'high' });
  });
});
