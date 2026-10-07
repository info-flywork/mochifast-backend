import { addDays } from '../../shared/time.js';
import { dayKept } from '../stats/stats.rules.js';

/**
 * Mochi World (docs/backend/05-is-kurallari.md §7). Saf fonksiyonlar.
 */

/** Bölge → metrik (API adı, birim) ve `user_stats` kaynağı. */
export const ZONES = Object.freeze([
  { zone: 'forest', metric: 'completedFasts', unit: 'fasts', stat: 'completed_fasts' },
  { zone: 'lake', metric: 'waterGoalDays', unit: 'days', stat: 'water_goal_days' },
  { zone: 'summit', metric: 'weightLostKg', unit: 'kg', stat: 'best_weight_lost_kg' },
  { zone: 'garden', metric: 'mealsLogged', unit: 'meals', stat: 'meals_logged' },
]);
export const MAX_ZONE_LEVEL = 4;

/**
 * @param thresholds artan eşikler (seviye 1→4)
 * @returns {level 0–4, nextThreshold|null, ratioToNext 0–1}
 */
export function zoneState(current, thresholds) {
  const value = Number(current) || 0;
  const level = thresholds.filter((t) => value >= t).length;
  const next = thresholds[level] ?? null;
  const previous = level > 0 ? thresholds[level - 1] : 0;
  const ratioToNext =
    next === null ? 0 : Math.round(((value - previous) / (next - previous)) * 1000) / 1000;
  return { level, nextThreshold: next, ratioToNext: Math.min(1, Math.max(0, ratioToNext)) };
}

/** Bölgelerin ortalama ilerlemesi (0–1). */
export function worldProgress(zones) {
  if (zones.length === 0) return 0;
  const sum = zones.reduce(
    (a, z) =>
      a + Math.min(1, (z.level + (z.level >= MAX_ZONE_LEVEL ? 0 : z.ratioToNext)) / MAX_ZONE_LEVEL),
    0,
  );
  return Math.round((sum / zones.length) * 1000) / 1000;
}

/** Görsel sahne seviyesi: en gelişmiş bölge. */
export const sceneLevel = (zones) => zones.reduce((m, z) => Math.max(m, z.level), 0);

/**
 * Adanın sağlığı (05 §7.2): son tutulan günden bu yana kaçırılan ZORUNLU gün sayısı (bugün
 * hariç). Bugün tutulduysa boşluk 0: tek iyi gün adayı hemen toparlar (bilinçli seçim).
 * Nötr günler (haftalık planın normal günü) sayılmaz. İlk günden 2 gün geçmediyse thriving.
 */
export function worldHealth({ firstDay, today, resolveDay, fasted, checkins }) {
  if (!firstDay || addDays(firstDay, 2) > today) return 'thriving';
  const kept = (d) => dayKept(resolveDay(d), fasted.get(d) ?? 0, checkins.get(d));
  if (kept(today) === true) return 'thriving';
  let gap = 0;
  for (let d = addDays(today, -1); d >= firstDay; d = addDays(d, -1)) {
    const result = kept(d);
    if (result === true) break;
    if (result === false) gap += 1;
    if (gap >= 4) break; // sonuç belli: drought
  }
  if (gap <= 1) return 'thriving';
  return gap <= 3 ? 'wilting' : 'drought';
}
