import { describe, expect, it } from 'vitest';
import {
  assertStartWindow,
  bodyStage,
  cancelDeletes,
  eatingStage,
  finishOutcome,
  overlaps,
  progressOf,
} from '../../src/modules/fasting/fasting.rules.js';
import {
  dayTarget,
  resolveDailyWindow,
  resolveWeeklySchedule,
} from '../../src/modules/plans/plans.rules.js';

const at = (iso) => new Date(iso);
/** Doğrulama hatasının alan mesajı (AppError details.fields[0].message). */
function fieldError(fn) {
  try {
    fn();
  } catch (err) {
    return err.details?.fields?.[0]?.message ?? err.code;
  }
  return null;
}
const H = 3_600_000;
const now = at('2026-10-07T12:00:00Z');

describe('oruç kuralları (05 §1)', () => {
  it('başlangıç penceresi: 7 gün geriye, 5 dk ileriye', () => {
    expect(() => assertStartWindow(new Date(now - 6 * 24 * H), now)).not.toThrow();
    expect(() => assertStartWindow(new Date(now - 8 * 24 * H), now)).toThrow();
    expect(() => assertStartWindow(new Date(+now + 4 * 60_000), now)).not.toThrow();
    expect(() => assertStartWindow(new Date(+now + 6 * 60_000), now)).toThrow();
  });

  it('bitiş: süre, hedef, durum ve uzun aşım uyarısı', () => {
    const startedAt = at('2026-10-06T20:00:00Z');
    expect(
      finishOutcome({ startedAt, endedAt: at('2026-10-07T09:00:00Z'), targetMinutes: 960, now }),
    ).toEqual({
      durationMinutes: 780,
      goalReached: false,
      status: 'ended_early',
      warnings: [],
    });
    expect(
      finishOutcome({ startedAt, endedAt: at('2026-10-07T12:00:00Z'), targetMinutes: 960, now })
        .status,
    ).toBe('completed');
    const late = finishOutcome({
      startedAt: at('2026-10-05T10:00:00Z'),
      endedAt: at('2026-10-06T15:00:00Z'),
      targetMinutes: 960,
      now,
    });
    expect(late.warnings).toEqual(['LONG_OVERRUN']);
    expect(() =>
      finishOutcome({ startedAt, endedAt: at('2026-10-06T20:00:30Z'), targetMinutes: 960, now }),
    ).toThrow();
  });

  it('10 dk iptal kuralı ve çakışma', () => {
    expect(cancelDeletes(new Date(now - 9 * 60_000), now)).toBe(true);
    expect(cancelDeletes(new Date(now - 11 * 60_000), now)).toBe(false);
    const a = [at('2026-10-06T10:00:00Z'), at('2026-10-06T20:00:00Z')];
    expect(overlaps(...a, at('2026-10-06T19:00:00Z'), at('2026-10-07T01:00:00Z'))).toBe(true);
    expect(overlaps(...a, at('2026-10-06T20:00:00Z'), at('2026-10-07T01:00:00Z'))).toBe(false);
  });

  it('vücut evresi ve sonraki evre zamanı; ilerleme', () => {
    const stages = [0, 2, 5, 8, 12, 16, 18, 24, 48].map((h, i) => ({
      position: i + 1,
      startHour: h,
      title: `S${i + 1}`,
      rangeLabel: null,
      imageKey: `a${i + 1}`,
    }));
    const start = at('2026-10-07T00:00:00Z');
    expect(bodyStage(13 * 60, stages, start)).toMatchObject({
      position: 5,
      nextStageAt: at('2026-10-07T16:00:00Z'),
    });
    expect(bodyStage(60 * 60, stages, start)).toMatchObject({ position: 9, nextStageAt: null });
    expect(progressOf(480, 960)).toBe(0.5);
    expect(progressOf(1200, 960)).toBe(1);
  });

  it('yeme penceresi evresi (05 §4)', () => {
    expect(eatingStage(10, 480)).toBe('break');
    expect(eatingStage(95, 480)).toBe('break');
    expect(eatingStage(200, 480)).toBe('nourish');
    expect(eatingStage(430, 480)).toBe('next');
    expect(eatingStage(480, 480)).toBeNull();
    expect(eatingStage(20, 60)).toBe('break');
  });
});

describe('plan kuralları (05 §2)', () => {
  const p168 = {
    code: '16_8',
    scheduleType: 'daily',
    fastHours: 16,
    eatHours: 8,
    allowedTimings: ['skip_breakfast', 'skip_dinner', 'early_window', 'late_window', 'custom'],
    defaultTiming: 'skip_breakfast',
    defaultEatStart: '12:00',
  };

  it('zamanlama tercihi → yeme penceresi', () => {
    expect(resolveDailyWindow(p168, { timing: 'skip_dinner' })).toEqual({
      timing: 'skip_dinner',
      fastMinutes: 960,
      eatWindow: { start: '08:00', end: '16:00' },
    });
    expect(resolveDailyWindow(p168, {}).eatWindow).toEqual({ start: '12:00', end: '20:00' });
    expect(resolveDailyWindow(p168, { timing: 'custom', eatStart: '18:00' }).eatWindow).toEqual({
      start: '18:00',
      end: '02:00',
    });
    expect(() => resolveDailyWindow(p168, { timing: 'custom' })).toThrow();
    expect(() =>
      resolveDailyWindow(p168, { timing: 'custom', eatStart: '10:00', eatEnd: '20:00' }),
    ).toThrow();
    const omad = {
      ...p168,
      code: 'omad',
      allowedTimings: ['skip_breakfast', 'skip_dinner', 'custom'],
    };
    expect(() => resolveDailyWindow(omad, { timing: 'early_window' })).toThrow();
  });

  it('özel günlük plan: pencereden oruç süresi, 12–23 sa sınırı', () => {
    const custom = { ...p168, code: 'custom_daily', scheduleType: 'custom_daily' };
    expect(
      resolveDailyWindow(custom, { timing: 'custom', eatStart: '10:00', eatEnd: '18:00' })
        .fastMinutes,
    ).toBe(960);
    expect(
      resolveDailyWindow(custom, { fastMinutes: 1200, timing: 'skip_breakfast' }).eatWindow,
    ).toEqual({
      start: '12:00',
      end: '16:00',
    });
    expect(() => resolveDailyWindow(custom, { fastMinutes: 600 })).toThrow();
  });

  const week = (types) => types.map((type, i) => ({ dow: i + 1, type }));

  it('5:2 — tam 2 azaltılmış gün, ardışık değil (Pazar→Pazartesi dahil)', () => {
    const p = {
      code: '5_2',
      scheduleType: 'weekly_reduced',
      reducedDaysPerWeek: 2,
      reducedDayKcal: 500,
    };
    const ok = resolveWeeklySchedule(
      p,
      week(['reduced', 'normal', 'normal', 'reduced', 'normal', 'normal', 'normal']),
    );
    expect(ok.filter((d) => d.type === 'reduced')).toEqual([
      { dow: 1, type: 'reduced', kcal: 500 },
      { dow: 4, type: 'reduced', kcal: 500 },
    ]);
    expect(
      fieldError(() =>
        resolveWeeklySchedule(
          p,
          week(['reduced', 'reduced', 'normal', 'normal', 'normal', 'normal', 'normal']),
        ),
      ),
    ).toMatch(/consecutive/);
    expect(() =>
      resolveWeeklySchedule(
        p,
        week(['reduced', 'normal', 'normal', 'normal', 'normal', 'normal', 'reduced']),
      ),
    ).toThrow();
    expect(() =>
      resolveWeeklySchedule(
        p,
        week(['reduced', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal']),
      ),
    ).toThrow();
  });

  it('crescendo — 2–3 ardışık olmayan 12–16 sa günü; özel haftalık', () => {
    const c = { code: 'crescendo', scheduleType: 'selected_days', fastHours: 14 };
    expect(
      resolveWeeklySchedule(
        c,
        week(['fast', 'normal', 'fast', 'normal', 'fast', 'normal', 'normal']),
      ).find((d) => d.dow === 1),
    ).toEqual({ dow: 1, type: 'fast', fastMinutes: 840 });
    expect(() =>
      resolveWeeklySchedule(c, [
        { dow: 1, type: 'fast', fastMinutes: 1200 },
        ...week(['normal', 'fast', 'normal', 'normal', 'normal', 'normal', 'normal']).slice(1),
      ]),
    ).toThrow();
    const cw = { code: 'custom_weekly', scheduleType: 'custom_weekly' };
    expect(() =>
      resolveWeeklySchedule(cw, [
        { dow: 1, type: 'fast', fastMinutes: 600 },
        ...week(['', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal']).slice(1),
      ]),
    ).toThrow();
  });

  it('günün hedefi: günlük plan her gün, haftalık planda yalnızca oruç günleri', () => {
    expect(dayTarget({ fastMinutes: 960, weeklySchedule: null }, 3)).toEqual({
      type: 'fast',
      fastMinutes: 960,
    });
    const weekly = {
      fastMinutes: 960,
      weeklySchedule: [
        { dow: 1, type: 'reduced', kcal: 500 },
        { dow: 2, type: 'fast', fastMinutes: 840 },
      ],
    };
    expect(dayTarget(weekly, 1)).toEqual({ type: 'reduced', fastMinutes: null });
    expect(dayTarget(weekly, 2)).toEqual({ type: 'fast', fastMinutes: 840 });
  });
});
