/**
 * AI maliyeti (docs/backend/09-yapay-zeka.md). Fiyatlar `app_config.ai.pricing`'ten gelir
 * (kodda değil; değişebilir). Kullanım ortak biçimde: `input_tokens`, `output_tokens`,
 * `cache_read_input_tokens`, `cache_creation_input_tokens` (`normalizeOpenAiUsage`).
 */

/** Sağlayıcının döndürdüğü tarihli sürüm eki: `gpt-4o-2024-08-06` → `gpt-4o`. */
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Model fiyatı. Yanıttaki model adı çoğu zaman tarihli sürümdür; tam ad yoksa eki atılmış ad
 * aranır. Önek eşleşmesi yapılmaz (`gpt-4o-mini` ≠ `gpt-4o`). Bulunamazsa undefined.
 */
export function priceFor(pricing, model) {
  if (!pricing || !model) return undefined;
  return pricing[model] ?? pricing[model.replace(DATED_SNAPSHOT, '')];
}

/** Token × fiyat (USD / milyon token) → mikro-USD. Fiyat yoksa 0. */
export function costMicroUsd(usage, price) {
  if (!usage || !price) return 0;
  return Math.round(
    (usage.input_tokens ?? 0) * (price.inputPerMTok ?? 0) +
      (usage.output_tokens ?? 0) * (price.outputPerMTok ?? 0) +
      (usage.cache_read_input_tokens ?? 0) * (price.cacheReadPerMTok ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) * (price.cacheWritePerMTok ?? 0),
  );
}
