import { readFileSync } from 'node:fs';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../config/constants.js';

const catalogs = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale) => [
    locale,
    JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8')),
  ]),
);

/**
 * `Accept-Language` header'ından desteklenen en iyi dili seçer (q-değerlerine göre).
 * "tr-TR,tr;q=0.9,en;q=0.8" → "tr". Hiçbiri desteklenmiyorsa varsayılan dil.
 */
export function resolveLocale(header) {
  if (!header) return DEFAULT_LOCALE;
  const candidates = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number(qParam.trim().slice(2)) : 1;
      return { base: tag.trim().toLowerCase().split('-')[0], q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((c) => c.base && c.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const c of candidates) {
    if (SUPPORTED_LOCALES.includes(c.base)) {
      return c.base;
    }
  }
  return DEFAULT_LOCALE;
}

/**
 * Noktalı anahtarla çeviri getirir; `{name}` yer tutucularını doldurur.
 * Dilde yoksa İngilizceye, o da yoksa anahtarın kendisine düşer.
 * @param key ör. "errors.NOT_FOUND"
 */
export function t(locale, key, params) {
  const template = lookup(catalogs[locale], key) ?? lookup(catalogs[DEFAULT_LOCALE], key) ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

function lookup(catalog, key) {
  let node = catalog;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}
