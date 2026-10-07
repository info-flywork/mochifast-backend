import { DEFAULT_FAST_MINUTES, dayTarget } from '../plans/plans.rules.js';
import { addDays, isoWeekday } from '../../shared/time.js';

/**
 * Seri, sayaç, XP ve seviye kuralları (docs/backend/05-is-kurallari.md §1.5, §3, §10).
 * Saf fonksiyonlar: girdiler ham tablolardan okunur, aynı girdi her zaman aynı sonucu verir.
 */

/** Zorunlu oruç günü, hedefin bu oranı tutulunca sayılır (16 sa planda 12 sa 48 dk). */
export const KEEP_RATIO = 0.8;

/** Sayaçlara ve XP'ye giren en kısa oruç. */
export const MIN_COUNTED_FAST_MINUTES = 60;

export const FAST_XP = 10;
export const WATER_GOAL_XP = 5;
export const WEIGHT_LOGGED_XP = 3;
export const MEAL_XP = 2;
export const MEAL_XP_DAILY_CAP = 5;
export const HUNGER_XP = 2;
export const HUNGER_XP_DAILY_CAP = 3;
export const FAST_GOAL_BONUS_XP = 5;
/** Hedefe ulaşma bonusu yalnızca bu süreye kadarki hedeflerde verilir (uzun oruç teşvik edilmez). */
export const GOAL_BONUS_MAX_TARGET = 24 * 60;

/** [gün, XP] — 05 §3.2 ve §10. */
export const STREAK_MILESTONES = Object.freeze([
  [3, 20],
  [7, 50],
  [14, 100],
  [30, 200],
  [60, 300],
  [100, 500],
]);

/** n. seviyeye çıkmak için gereken toplam XP: L1=0, L2=100, L3=300, L4=600 … */
export function xpForLevel(n) {
  return 50 * n * (n - 1);
}

export function levelFor(xp) {
  let n = 1;
  while (xpForLevel(n + 1) <= xp) n += 1;
  return n;
}

export function levelProgress(xp) {
  const level = levelFor(xp);
  return { level, xp, levelXp: xpForLevel(level), nextLevelXp: xpForLevel(level + 1) };
}

/** Oruç seansının kazandırdığı XP olayları. */
export function fastXp({ status, durationMinutes, goalReached, targetMinutes }) {
  if (!['completed', 'ended_early'].includes(status)) return [];
  if ((durationMinutes ?? 0) < MIN_COUNTED_FAST_MINUTES) return [];
  const events = [{ reason: 'fast_completed', amount: FAST_XP }];
  if (goalReached && targetMinutes <= GOAL_BONUS_MAX_TARGET) {
    events.push({ reason: 'fast_goal_bonus', amount: FAST_GOAL_BONUS_XP });
  }
  return events;
}

/**
 * Plan geçmişinden gün çözücü. Bir günün planı, o gün ya da daha önce başlamış en son plandır
 * (gün içinde plan değiştiyse yenisi geçerlidir). Plan yoksa varsayılan günlük 16 sa.
 * @param plans `startedOn` (YYYY-MM-DD) artan sıralı kullanıcı planları
 */
export function dayResolver(plans) {
  return (isoDay) => {
    let plan = null;
    for (const p of plans) {
      if (p.startedOn <= isoDay) plan = p;
      else break;
    }
    if (!plan) {
      return { type: 'fast', goalMinutes: DEFAULT_FAST_MINUTES, required: true, weekly: false };
    }
    const t = dayTarget(plan, isoWeekday(isoDay));
    return {
      type: t.type,
      goalMinutes: t.type === 'fast' ? t.fastMinutes : null,
      required: t.type !== 'normal',
      weekly: Boolean(plan.weeklySchedule),
    };
  };
}

/**
 * Gün tutuldu mu? Oruç günü hedefin %80'i ile; haftalık planın günü ayrıca check-in ile.
 * @returns true/false; nötr günde null
 */
export function dayKept(day, fastedMinutes, checkin, keepRatio = KEEP_RATIO) {
  if (!day.required) return null;
  if (checkin === 'done') return true;
  return day.goalMinutes !== null && fastedMinutes >= keepRatio * day.goalMinutes;
}

/**
 * Serileri ilk günden bugüne ileri doğru yürüterek hesaplar (05 §3.2 ile eşdeğer):
 * - nötr gün seriyi sürdürür (+1), tutulmuş zorunlu gün +1, tutulmayan zorunlu gün sıfırlar;
 * - bugün zorunlu ve henüz tutulmadıysa seriyi bozmaz (gün sürüyor).
 * Kilometre taşları her seri için bir kez, ulaşıldığı güne yazılır.
 *
 * @param firstDay ilk plan günü ya da ilk oruç günü (öncesi sayılmaz); yoksa null
 * @param fasted Map<YYYY-MM-DD, dakika>
 * @param checkins Map<YYYY-MM-DD, 'done'|'skipped'>
 */
export function computeStreaks({ firstDay, today, resolveDay, fasted, checkins, keepRatio }) {
  const result = { current: 0, best: 0, runStart: null, milestones: [] };
  if (!firstDay || firstDay > today) return result;

  let run = 0;
  let runStart = null;
  for (let d = firstDay; d <= today; d = addDays(d, 1)) {
    const day = resolveDay(d);
    const kept = dayKept(day, fasted.get(d) ?? 0, checkins.get(d), keepRatio);
    if (kept === false && d === today) break; // bugün sürüyor
    if (kept === false) {
      run = 0;
      runStart = null;
      continue;
    }
    if (run === 0) runStart = d;
    run += 1;
    result.best = Math.max(result.best, run);
    const milestone = STREAK_MILESTONES.find(([days]) => days === run);
    if (milestone) {
      result.milestones.push({ days: run, xp: milestone[1], date: d, runStart });
    }
  }
  result.current = run;
  result.runStart = run > 0 ? runStart : null;
  return result;
}
