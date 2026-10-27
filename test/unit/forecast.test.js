import { describe, expect, it } from 'vitest';
import { pickTip } from '../../src/modules/fasting/daily-tip.js';
import {
  dayClass,
  forecastCurve,
  forecastStats,
  upcomingFast,
} from '../../src/modules/fasting/forecast.js';

describe('Fast Forecast', () => {
  it('az veride kapalı; Laplace + seri bonusu, sınırlar', () => {
    expect(forecastStats({ ended: 2, reached: 2, streak: 5, struggleElapsed: [] })).toEqual({
      available: false,
    });
    expect(forecastStats({ ended: 4, reached: 3, streak: 0, struggleElapsed: [] })).toEqual({
      available: true,
      successChance: 0.67,
      basedOnFasts: 4,
      toughestElapsedHour: null,
    });
    // Seri bonusu en çok 7 gün (+%7); üst sınır %97, alt sınır %5.
    expect(
      forecastStats({ ended: 4, reached: 3, streak: 30, struggleElapsed: [] }).successChance,
    ).toBe(0.74);
    expect(
      forecastStats({ ended: 40, reached: 40, streak: 7, struggleElapsed: [] }).successChance,
    ).toBe(0.97);
    expect(
      forecastStats({ ended: 40, reached: 0, streak: 0, struggleElapsed: [] }).successChance,
    ).toBe(0.05);
  });

  it('en zor saat: en sık; eşitlikte erken saat; en az 3 olay', () => {
    const at = (h, m = 0) => h * 60 + m;
    expect(
      forecastStats({
        ended: 5,
        reached: 5,
        streak: 0,
        struggleElapsed: [at(14, 5), at(14, 50), at(9)],
      }).toughestElapsedHour,
    ).toBe(14);
    expect(
      forecastStats({
        ended: 5,
        reached: 5,
        streak: 0,
        struggleElapsed: [at(15), at(9), at(9, 30), at(15, 10)],
      }).toughestElapsedHour,
    ).toBe(9);
    expect(
      forecastStats({ ended: 5, reached: 5, streak: 0, struggleElapsed: [at(9), at(9)] })
        .toughestElapsedHour,
    ).toBeNull();
  });

  it('gün sınıfı: erken bitiş ve sık zorlanma zor, temiz hedef kolay', () => {
    expect(dayClass({ status: 'ended_early', goalReached: false, struggles: 0 })).toBe('hard');
    expect(dayClass({ status: 'completed', goalReached: true, struggles: 2 })).toBe('hard');
    expect(dayClass({ status: 'completed', goalReached: true, struggles: 0 })).toBe('easy');
    expect(dayClass({ status: 'completed', goalReached: true, struggles: 1 })).toBe('moderate');
  });

  it('eğri kayıtların saatine oturur; kayıt yoksa düz ve tepesiz', () => {
    const at = (h, m = 0) => h * 60 + m;
    const shaped = forecastCurve({
      fastMinutes: 16 * 60,
      struggles: [at(10, 5), at(10, 40), at(4)],
      hungers: [{ fastedMinutes: at(10, 20), physicalScore: 6 }],
      breaks: [at(10, 15)],
    });
    expect(shaped.toughestElapsedHour).toBe(10);
    expect(shaped.curve).toHaveLength(17);
    expect(Math.max(...shaped.curve)).toBe(1);
    expect(shaped.riskStartHour).toBeLessThanOrEqual(10);
    expect(shaped.riskEndHour).toBeGreaterThan(10);

    const empty = forecastCurve({
      fastMinutes: 16 * 60,
      struggles: [],
      hungers: [],
      breaks: [],
    });
    expect(empty.toughestElapsedHour).toBeNull();
    expect(empty.curve.every((v) => v === 0)).toBe(true);
    expect(empty.riskStartHour).toBeNull();
  });

  it('sıradaki oruç: aktif oruç; yoksa yeme penceresi sonundan (geçtiyse yarın, DST güvenli)', () => {
    const active = {
      startedAt: new Date('2026-10-07T17:00:00Z'),
      plannedEndAt: new Date('2026-10-08T09:00:00Z'),
    };
    expect(upcomingFast({ active, plan: null, timezone: 'Europe/Istanbul' })).toEqual({
      active: true,
      ...{ startsAt: active.startedAt, endsAt: active.plannedEndAt },
    });

    const plan = { fastMinutes: 960, eatWindowEnd: '20:00' };
    // 12:00 İstanbul (09:00Z): bugün 20:00 (17:00Z)
    const today = upcomingFast({
      active: null,
      plan,
      timezone: 'Europe/Istanbul',
      now: new Date('2026-10-07T09:00:00Z'),
    });
    expect(today).toEqual({
      active: false,
      startsAt: new Date('2026-10-07T17:00:00Z'),
      endsAt: new Date('2026-10-08T09:00:00Z'),
    });
    // 21:00 İstanbul: yarın 20:00
    const tomorrow = upcomingFast({
      active: null,
      plan,
      timezone: 'Europe/Istanbul',
      now: new Date('2026-10-07T18:00:00Z'),
    });
    expect(tomorrow.startsAt).toEqual(new Date('2026-10-08T17:00:00Z'));
    // Plan/pencere yoksa null
    expect(
      upcomingFast({
        active: null,
        plan: { fastMinutes: 960, eatWindowEnd: null },
        timezone: 'UTC',
      }),
    ).toBeNull();
  });

  it('günün ipucu: kullanıcı + gün için sabit, sıradan bağımsız; günler arasında dağılır', () => {
    const codes = ['fast_a', 'fast_b', 'fast_c', 'fast_d'];
    const one = pickTip(codes, 'u1', '2026-10-07');
    expect(pickTip([...codes].reverse(), 'u1', '2026-10-07')).toBe(one);
    const days = new Set(
      Array.from({ length: 30 }, (_, i) =>
        pickTip(codes, 'u1', `2026-11-${String(i + 1).padStart(2, '0')}`),
      ),
    );
    expect(days.size).toBeGreaterThan(1);
    expect(pickTip([], 'u1', '2026-10-07')).toBeNull();
  });
});
