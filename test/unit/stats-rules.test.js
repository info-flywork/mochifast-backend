import { describe, expect, it } from 'vitest';
import {
  computeStreaks,
  dayKept,
  dayResolver,
  fastXp,
  levelFor,
  levelProgress,
  xpForLevel,
} from '../../src/modules/stats/stats.rules.js';
import { weightProgress } from '../../src/modules/user/summary.service.js';
import { addDays } from '../../src/shared/time.js';

const TODAY = '2026-10-07'; // Çarşamba
const daily = (fastMinutes = 960, startedOn = '2026-01-01') => ({
  startedOn,
  fastMinutes,
  weeklySchedule: null,
});
// 5:2 — Pazartesi (1) ve Perşembe (4) azaltılmış gün, diğerleri normal.
const fiveTwo = (startedOn = '2026-01-01') => ({
  startedOn,
  fastMinutes: 960,
  weeklySchedule: [1, 2, 3, 4, 5, 6, 7].map((dow) =>
    dow === 1 || dow === 4 ? { dow, type: 'reduced', kcal: 500 } : { dow, type: 'normal' },
  ),
});
const days = (entries) => new Map(entries);
const back = (n) => addDays(TODAY, -n);

function streaks({ plans = [daily()], fasted = [], checkins = [], firstDay = back(30) } = {}) {
  return computeStreaks({
    firstDay,
    today: TODAY,
    resolveDay: dayResolver(plans),
    fasted: days(fasted),
    checkins: days(checkins),
  });
}

describe('seviye (05 §10)', () => {
  it('gereken XP: L1=0, L2=100, L3=300, L4=600, L5=1000', () => {
    expect([1, 2, 3, 4, 5].map(xpForLevel)).toEqual([0, 100, 300, 600, 1000]);
    expect([0, 99, 100, 299, 300, 600, 999, 1000].map(levelFor)).toEqual([1, 1, 2, 2, 3, 4, 4, 5]);
    expect(levelProgress(380)).toEqual({ level: 3, xp: 380, levelXp: 300, nextLevelXp: 600 });
  });

  it('oruç XP: 10 + hedef bonusu 5 (hedef ≤ 24 sa); 60 dk altı ve iptal puansız', () => {
    const base = {
      status: 'completed',
      durationMinutes: 970,
      goalReached: true,
      targetMinutes: 960,
    };
    const total = (s) => fastXp(s).reduce((a, e) => a + e.amount, 0);
    expect(total(base)).toBe(15);
    expect(total({ ...base, status: 'ended_early', goalReached: false })).toBe(10);
    expect(total({ ...base, targetMinutes: 1500, durationMinutes: 1500 })).toBe(10);
    expect(total({ ...base, durationMinutes: 59 })).toBe(0);
    expect(total({ ...base, status: 'cancelled' })).toBe(0);
  });
});

describe('gün çözücü ve tutulma', () => {
  it('plan yoksa günlük 16 sa; plan başlangıcından itibaren planın günü', () => {
    const resolve = dayResolver([daily(840, '2026-10-05')]);
    expect(resolve('2026-10-04')).toMatchObject({ type: 'fast', goalMinutes: 960, required: true });
    expect(resolve('2026-10-05')).toMatchObject({ type: 'fast', goalMinutes: 840 });
  });

  it('aynı gün plan değiştiyse sonraki geçerli', () => {
    const resolve = dayResolver([daily(960, TODAY), daily(720, TODAY)]);
    expect(resolve(TODAY).goalMinutes).toBe(720);
  });

  it('haftalık planda normal gün nötr, azaltılmış gün zorunlu', () => {
    const resolve = dayResolver([fiveTwo()]);
    expect(resolve('2026-10-05')).toMatchObject({ type: 'reduced', required: true }); // Pzt
    expect(resolve('2026-10-06')).toMatchObject({ type: 'normal', required: false }); // Sal
  });

  it('%80 kuralı: 16 sa planında 13 sa tutar, 12 sa tutmaz; check-in her zaman tutar', () => {
    const day = { type: 'fast', goalMinutes: 960, required: true };
    expect(dayKept(day, 780)).toBe(true);
    expect(dayKept(day, 720)).toBe(false);
    expect(dayKept(day, 0, 'done')).toBe(true);
    expect(dayKept({ type: 'normal', goalMinutes: null, required: false }, 0)).toBeNull();
    expect(dayKept({ type: 'reduced', goalMinutes: null, required: true }, 0)).toBe(false);
  });
});

describe('seri (05 §3)', () => {
  it('ardışık tutulmuş günler; bugün sürüyorsa seri bozulmaz', () => {
    const r = streaks({
      fasted: [
        [back(3), 960],
        [back(2), 780],
        [back(1), 1000],
      ],
    });
    expect(r.current).toBe(3);
    expect(r.runStart).toBe(back(3));
  });

  it('bugün tutulduysa sayılır', () => {
    expect(
      streaks({
        fasted: [
          [back(1), 960],
          [TODAY, 960],
        ],
      }).current,
    ).toBe(2);
  });

  it('kaçırılan gün sıfırlar; en iyi seri korunur', () => {
    const r = streaks({
      fasted: [
        [back(6), 960],
        [back(5), 960],
        [back(4), 960],
        [back(3), 960],
        // back(2) yok
        [back(1), 960],
      ],
    });
    expect(r.current).toBe(1);
    expect(r.best).toBe(4);
  });

  it('dün kaçırıldıysa ve bugün henüz oruç yoksa seri 0', () => {
    expect(
      streaks({
        fasted: [
          [back(3), 960],
          [back(2), 960],
        ],
      }).current,
    ).toBe(0);
  });

  it('ilk günden öncesi sayılmaz; hiç başlangıç yoksa 0', () => {
    expect(streaks({ fasted: [[back(1), 960]], firstDay: back(1) }).current).toBe(1);
    expect(streaks({ firstDay: null }).current).toBe(0);
  });

  it('5:2: nötr günler sürdürür, azaltılmış gün check-in ister', () => {
    // TODAY Çarşamba: back(2)=Pzt azaltılmış, back(6)=Perşembe azaltılmış.
    const base = { plans: [fiveTwo()], firstDay: back(5) };
    expect(streaks(base).current).toBe(2); // Pzt kaçırıldı → Sal, Çar
    expect(streaks({ ...base, checkins: [[back(2), 'done']] }).current).toBe(6);
    expect(streaks({ ...base, checkins: [[back(2), 'skipped']] }).current).toBe(2);
  });

  it('kilometre taşları her seride bir kez, ulaşıldığı güne', () => {
    const fasted = [];
    for (let i = 10; i >= 1; i -= 1) if (i !== 4) fasted.push([back(i), 960]);
    const r = streaks({ fasted });
    // Seri 1: back(10)..back(5) = 6 gün → 3; seri 2: back(3)..back(1) = 3 gün → 3.
    expect(r.milestones).toEqual([
      { days: 3, xp: 20, date: back(8), runStart: back(10) },
      { days: 3, xp: 20, date: back(1), runStart: back(3) },
    ]);
    expect(r.best).toBe(6);
  });

  it('7 günlük seri: 3 ve 7 kilometre taşı', () => {
    const fasted = Array.from({ length: 7 }, (_, i) => [back(i + 1), 960]);
    expect(streaks({ fasted }).milestones.map((m) => m.days)).toEqual([3, 7]);
  });
});

describe('kilo ilerlemesi', () => {
  it('başlangıçtan hedefe kat edilen yol, 0–1 arası', () => {
    const w = (current) =>
      weightProgress({ startWeightKg: 112.2, currentWeightKg: current, goalWeightKg: 75.2 });
    expect(w(102.5).progress).toBeCloseTo(0.262, 3);
    expect(w(120).progress).toBe(0);
    expect(w(70).progress).toBe(1);
    expect(
      weightProgress({ startWeightKg: 80, currentWeightKg: 80, goalWeightKg: null }).progress,
    ).toBeNull();
  });
});
