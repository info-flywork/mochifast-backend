import { describe, expect, it } from 'vitest';
import { resolveLocale, t } from '../../src/shared/i18n.js';
import {
  fromBin,
  isAcceptableClientId,
  newId,
  toBin,
  uuidV7Timestamp,
} from '../../src/shared/ids.js';
import { addDays, isValidTimezone, localDate, mondayOf } from '../../src/shared/time.js';
import { decodeCursor, encodeCursor, toPage } from '../../src/shared/pagination.js';
import { AppError } from '../../src/shared/errors.js';

describe('i18n', () => {
  it.each([
    [undefined, 'en'],
    ['tr-TR,tr;q=0.9,en;q=0.8', 'tr'],
    ['pt-BR,de;q=0.5', 'de'],
    ['ja', 'en'],
    ['en;q=0.2,ru;q=0.9', 'ru'],
    ['fr;q=0,es', 'es'],
    ['  IT-it ', 'it'],
  ])('resolveLocale(%s) → %s', (header, expected) => {
    expect(resolveLocale(header)).toBe(expected);
  });

  it('çeviri, İngilizce yedek ve yer tutucu', () => {
    expect(t('tr', 'errors.NOT_FOUND')).toBe('Aradığın şeyi bulamadık.');
    expect(t('tr', 'errors.YOK_BOYLE')).toBe('errors.YOK_BOYLE');
    expect(t('xx', 'common.ok')).toBe('OK');
  });
});

describe('ids', () => {
  it('UUIDv7 ↔ BINARY(16) gidiş-dönüş', () => {
    const id = newId();
    const bin = toBin(id);
    expect(bin).toHaveLength(16);
    expect(fromBin(bin)).toBe(id);
    expect(fromBin(null)).toBeNull();
  });

  it('istemci ID kabulü: v7 + makul zaman', () => {
    const now = Date.now();
    const id = newId();
    expect(Math.abs(uuidV7Timestamp(id) - now)).toBeLessThan(5_000);
    expect(isAcceptableClientId(id)).toBe(true);
    expect(isAcceptableClientId('6f1c2a0e-8b7d-4c3e-9f2a-1b2c3d4e5f60')).toBe(false); // v4
    expect(isAcceptableClientId(id, { now: now + 30 * 24 * 3600 * 1000 })).toBe(false);
    expect(isAcceptableClientId('not-a-uuid')).toBe(false);
  });
});

describe('time', () => {
  it('yerel gün saat dilimine göre hesaplanır (gece yarısı sınırı)', () => {
    // 2026-10-06T21:30Z = İstanbul'da 7 Ekim 00:30
    const instant = Date.UTC(2026, 9, 6, 21, 30);
    expect(localDate(instant, 'Europe/Istanbul')).toBe('2026-10-07');
    expect(localDate(instant, 'America/New_York')).toBe('2026-10-06');
  });

  it('DST geçişinde doğru gün (Berlin, 25 Ekim 2026)', () => {
    expect(localDate(Date.UTC(2026, 9, 25, 0, 30), 'Europe/Berlin')).toBe('2026-10-25');
  });

  it('hafta Pazartesi başlar', () => {
    expect(mondayOf('2026-10-11')).toBe('2026-10-05'); // Pazar → önceki Pazartesi
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('saat dilimi doğrulama', () => {
    expect(isValidTimezone('Europe/Istanbul')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
    expect(() => localDate(0, 'Mars/Olympus')).toThrow();
  });
});

describe('pagination', () => {
  it('cursor gidiş-dönüş ve doğrulama', () => {
    const c = encodeCursor({ createdAt: '2026-10-06T10:00:00.000Z', id: 'abc' });
    expect(decodeCursor(c, ['createdAt', 'id'])).toEqual({
      createdAt: '2026-10-06T10:00:00.000Z',
      id: 'abc',
    });
    expect(decodeCursor(undefined, ['id'])).toBeNull();
    expect(() => decodeCursor('bozuk!!', ['id'])).toThrow(AppError);
    expect(() => decodeCursor(encodeCursor({ other: 1 }), ['id'])).toThrow(AppError);
  });

  it('limit+1 satırdan sayfa üretir', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const page = toPage(rows, 2, (r) => ({ id: r.id }));
    expect(page.items).toHaveLength(2);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(decodeCursor(page.pageInfo.nextCursor, ['id'])).toEqual({
      id: 2,
    });
    expect(toPage(rows, 5, (r) => ({ id: r.id })).pageInfo).toEqual({
      nextCursor: null,
      hasMore: false,
    });
  });
});
