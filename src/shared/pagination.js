import { AppError } from './errors.js';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * Opak cursor: `(sortKey, id)` çiftinin base64url JSON'u. Offset kullanılmaz.
 */
export function encodeCursor(position) {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

export function decodeCursor(cursor, requiredKeys) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const valid =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      requiredKeys.every((k) => typeof value[k] === 'string' || typeof value[k] === 'number');
    if (!valid) throw new Error('shape');
    return value;
  } catch {
    throw new AppError('VALIDATION_FAILED', {
      details: { fields: [{ path: 'cursor', message: 'invalid cursor' }] },
    });
  }
}

/**
 * Bir sayfa fazlasını (`limit + 1`) çeken sorgunun sonucundan sayfa üretir.
 */
export function toPage(rows, limit, positionOf) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    pageInfo: { nextCursor: hasMore && last ? encodeCursor(positionOf(last)) : null, hasMore },
  };
}
