import { describe, expect, it } from 'vitest';
import {
  atLocal,
  fastNotifications,
  quietUntil,
} from '../../src/modules/notifications/notifications.rules.js';
import { localDate } from '../../src/shared/time.js';

/**
 * Yaz saati (DST) geçişleri (F11). 2026 geçişleri:
 * - Europe/Berlin: 29 Mart 02:00 → 03:00 (CET→CEST), 25 Ekim 03:00 → 02:00
 * - America/New_York: 8 Mart 02:00 → 03:00, 1 Kasım 02:00 → 01:00
 * - America/Santiago: 6 Eylül 00:00 → 01:00 (yerel gece yarısı hiç yaşanmaz)
 */
const H = 3_600_000;

describe('DST: yerel gün', () => {
  it('geçiş gecesinde yerel tarih doğru', () => {
    // Berlin ileri alma: 00:30Z = 01:30 CET, 01:30Z = 03:30 CEST
    expect(localDate(new Date('2026-03-29T00:30:00Z'), 'Europe/Berlin')).toBe('2026-03-29');
    expect(localDate(new Date('2026-03-28T22:59:00Z'), 'Europe/Berlin')).toBe('2026-03-28');
    // Santiago: 03:59Z = 23:59 (-04), 04:00Z = 01:00 (-03) → gün 6 Eylül
    expect(localDate(new Date('2026-09-06T03:59:00Z'), 'America/Santiago')).toBe('2026-09-05');
    expect(localDate(new Date('2026-09-06T04:00:00Z'), 'America/Santiago')).toBe('2026-09-06');
  });
});

describe('DST: sessiz saatler', () => {
  it('ileri alma gecesi: bitiş yerel 08:00 (CEST)', () => {
    // 00:30Z = 01:30 CET, sessiz 22:30–08:00 → 08:00 CEST = 06:00Z
    expect(quietUntil(new Date('2026-03-29T00:30:00Z'), 'Europe/Berlin', '22:30', '08:00')).toEqual(
      new Date('2026-03-29T06:00:00Z'),
    );
  });

  it('geri alma gecesi: bitiş yerel 08:00 (CET); gece 1 saat uzun', () => {
    // 00:30Z = 02:30 CEST (ilk 02:30), bitiş 08:00 CET = 07:00Z
    expect(quietUntil(new Date('2026-10-25T00:30:00Z'), 'Europe/Berlin', '22:30', '08:00')).toEqual(
      new Date('2026-10-25T07:00:00Z'),
    );
    // New York geri alma: 05:30Z = 01:30 EDT, bitiş 07:00 EST = 12:00Z
    expect(
      quietUntil(new Date('2026-11-01T05:30:00Z'), 'America/New_York', '23:00', '07:00'),
    ).toEqual(new Date('2026-11-01T12:00:00Z'));
  });
});

describe('DST: yerel saatte planlama', () => {
  it('yaşanmayan saat (ileri alma) bir sonraki geçerli ana kayar', () => {
    // Berlin 29 Mart 02:30 yok → 03:30 CEST = 01:30Z
    expect(atLocal('2026-03-29', '02:30', 'Europe/Berlin')).toEqual(
      new Date('2026-03-29T01:30:00Z'),
    );
    // Santiago 6 Eylül 00:30 yok → 01:30 -03 = 04:30Z
    expect(atLocal('2026-09-06', '00:30', 'America/Santiago')).toEqual(
      new Date('2026-09-06T04:30:00Z'),
    );
  });

  it('iki kez yaşanan saat (geri alma) ilk geçişe denk gelir; günün diğer saatleri kaymaz', () => {
    expect(atLocal('2026-10-25', '02:30', 'Europe/Berlin')).toEqual(
      new Date('2026-10-25T00:30:00Z'),
    );
    expect(atLocal('2026-10-25', '20:00', 'Europe/Berlin')).toEqual(
      new Date('2026-10-25T19:00:00Z'),
    );
    expect(atLocal('2026-10-24', '20:00', 'Europe/Berlin')).toEqual(
      new Date('2026-10-24T18:00:00Z'),
    );
  });

  it('oruç süresi mutlak: DST gecesi 16 saatlik oruç 16 saat sürer (duvar saati 15/17)', () => {
    const startedAt = new Date('2026-03-28T19:00:00Z'); // 20:00 CET
    const [goal] = fastNotifications({
      id: 'f',
      startedAt,
      targetMinutes: 960,
      plannedEndAt: new Date(startedAt.getTime() + 16 * H),
    });
    expect(goal.fireAt.getTime() - startedAt.getTime()).toBe(16 * H);
    // Yerelde 20:00 → ertesi gün 13:00 CEST (duvar saati 17 sa)
    expect(goal.fireAt).toEqual(new Date('2026-03-29T11:00:00Z'));
  });
});
