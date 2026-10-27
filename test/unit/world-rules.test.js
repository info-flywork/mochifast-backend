import { describe, expect, it } from 'vitest';
import { computeZones } from '../../src/modules/gamification/gamification.repository.js';
import {
  nextSceneUserLevel,
  sceneLevel,
  worldHealth,
  worldProgress,
  zoneState,
} from '../../src/modules/gamification/world.rules.js';
import { dayResolver } from '../../src/modules/stats/stats.rules.js';
import { addDays } from '../../src/shared/time.js';

const THRESHOLDS = {
  forest: [3, 10, 25, 50],
  lake: [3, 7, 14, 30],
  summit: [1, 2, 5, 10],
  garden: [3, 10, 30, 60],
};

describe('bölge durumu (05 §7.1)', () => {
  it('seviye, sonraki eşik, orana kalan', () => {
    expect(zoneState(0, THRESHOLDS.forest)).toEqual({ level: 0, nextThreshold: 3, ratioToNext: 0 });
    expect(zoneState(3, THRESHOLDS.forest)).toEqual({
      level: 1,
      nextThreshold: 10,
      ratioToNext: 0,
    });
    expect(zoneState(12, THRESHOLDS.forest)).toEqual({
      level: 2,
      nextThreshold: 25,
      ratioToNext: 0.133,
    });
    expect(zoneState(80, THRESHOLDS.forest)).toEqual({
      level: 4,
      nextThreshold: null,
      ratioToNext: 0,
    });
    expect(zoneState(1.2, THRESHOLDS.summit)).toMatchObject({ level: 1, nextThreshold: 2 });
  });

  it('kabul kriteri: mock senaryosu (3 oruç, 2 su günü, 0 kg, 3 öğün)', () => {
    const zones = computeZones({
      thresholds: THRESHOLDS,
      stats: { completed_fasts: 3, water_goal_days: 2, best_weight_lost_kg: 0, meals_logged: 3 },
      reached: {},
    });
    expect(
      Object.fromEntries(zones.map((z) => [z.zone, [z.level, z.current, z.nextThreshold]])),
    ).toEqual({
      forest: [1, 3, 10],
      lake: [0, 2, 3],
      summit: [0, 0, 1],
      garden: [1, 3, 10],
    });
    // forest 1/4, lake (0 + 2/3)/4, summit 0, garden 1/4 → ortalama
    expect(worldProgress(zones)).toBeCloseTo((0.25 + 0.1667 + 0 + 0.25) / 4, 2);
  });

  it('ada geri gitmez: metrik gerilese de ulaşılan seviye kalır', () => {
    const [summit] = computeZones({
      thresholds: { summit: THRESHOLDS.summit },
      stats: { best_weight_lost_kg: 0 },
      reached: { summit: 2 },
    }).filter((z) => z.zone === 'summit');
    expect(summit).toMatchObject({ level: 2, current: 0, nextThreshold: 5, ratioToNext: 0 });
  });

  it('tüm bölgeler 4 → ilerleme 1', () => {
    const zones = ['forest', 'lake', 'summit', 'garden'].map((zone) => ({
      zone,
      level: 4,
      ratioToNext: 0,
    }));
    expect(worldProgress(zones)).toBe(1);
  });
});

describe('ada sağlığı (05 §7.2)', () => {
  const TODAY = '2026-10-07';
  const back = (n) => addDays(TODAY, -n);
  const health = ({ fasted = [], checkins = [], firstDay = back(20), plans = [] } = {}) =>
    worldHealth({
      firstDay,
      today: TODAY,
      resolveDay: dayResolver(plans),
      fasted: new Map(fasted),
      checkins: new Map(checkins),
    });

  it('kabul kriteri: 4 zorunlu gün kaçırılınca drought; tek tutulmuş gün thriving yapar', () => {
    expect(health({ fasted: [[back(5), 960]] })).toBe('drought');
    expect(
      health({
        fasted: [
          [back(5), 960],
          [TODAY, 960],
        ],
      }),
    ).toBe('thriving');
  });

  it('boşluk 0–1 thriving, 2–3 wilting', () => {
    expect(health({ fasted: [[back(1), 960]] })).toBe('thriving');
    expect(health({ fasted: [[back(2), 960]] })).toBe('thriving');
    expect(health({ fasted: [[back(3), 960]] })).toBe('wilting');
    expect(health({ fasted: [[back(4), 960]] })).toBe('wilting');
  });

  it('nötr günler (haftalık planın normal günü) boşluğa sayılmaz', () => {
    const fiveTwo = {
      startedOn: '2026-01-01',
      fastMinutes: 960,
      weeklySchedule: [1, 2, 3, 4, 5, 6, 7].map((dow) =>
        dow === 1 || dow === 4 ? { dow, type: 'reduced', kcal: 500 } : { dow, type: 'normal' },
      ),
    };
    // TODAY Çarşamba: geride yalnızca Pzt (back 2) ve Per (back 6) zorunlu.
    expect(health({ plans: [fiveTwo], checkins: [[back(6), 'done']] })).toBe('thriving');
    expect(health({ plans: [fiveTwo], firstDay: back(9) })).toBe('wilting');
  });

  it('yeni kullanıcı (ilk günden < 2 gün) ve hiç başlangıç yoksa thriving', () => {
    expect(health({ firstDay: back(1) })).toBe('thriving');
    expect(health({ firstDay: null })).toBe('thriving');
  });
});

describe('sahne seviyesi (XP)', () => {
  it('XP seviyesinden 0–4 aşama', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12].map(sceneLevel)).toEqual([0, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('sonraki aşamanın açıldığı seviye', () => {
    expect([1, 2, 4, 6, 7].map(nextSceneUserLevel)).toEqual([2, 3, 5, 7, null]);
  });
});
