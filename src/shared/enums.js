/**
 * DB `snake_case` ↔ API `lowerCamelCase` enum dönüşümü (docs/backend/04-api.md "Enum eşlemesi").
 * Plan kodları ("16_8") enum DEĞİLDİR; bunlara uygulanmaz.
 */
export function toApiEnum(value) {
  return value === null || value === undefined
    ? value
    : value.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export function toDbEnum(value) {
  return value === null || value === undefined
    ? value
    : value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** MySQL SET kolonu ("a,b") ↔ API dizisi. */
export function setToApi(value) {
  return value ? value.split(',').filter(Boolean).map(toApiEnum) : [];
}

export function apiToSet(values) {
  return [...new Set(values.map(toDbEnum))].join(',');
}
