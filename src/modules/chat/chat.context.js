import { DateTime } from 'luxon';
import { toApiEnum } from '../../shared/enums.js';
import { toBin } from '../../shared/ids.js';
import { isValidTimezone, localDate } from '../../shared/time.js';
import { summariesBetween } from '../trackers/trackers.repository.js';
import * as userRepo from '../user/user.repository.js';
import { ageFromBirthYear } from '../user/onboarding.rules.js';

/**
 * Her kullanıcı mesajının başına eklenen bağlam bloğu (docs/backend/09-yapay-zeka.md §2.3).
 * Veri minimizasyonu: yalnızca takma ad (ilk ad) ve gereken sağlık bağlamı; e-posta, soyad,
 * cihaz bilgisi gönderilmez. Blok mesajla birlikte birebir saklanır (prompt cache).
 */

const GOALS = {
  lose_weight: 'lose weight',
  build_habit: 'build a healthy habit',
  more_energy: 'more energy',
  gut_reset: 'gut reset',
};
const LANGUAGE = {
  en: 'English',
  tr: 'Turkish',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  ru: 'Russian',
};

const hm = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m > 0 ? `${m}m` : ''}` : `${m}m`;
};
const clock = (iso, tz) => DateTime.fromISO(iso, { zone: tz }).toFormat('HH:mm');
const clean = (s, max = 40) =>
  String(s ?? '')
    .replace(/[<>\n\r]/g, ' ')
    .trim()
    .slice(0, max);

/**
 * Saf biçimleyici. Satır sırası sabit, değerler kısa: model için okunaklı, token açısından ucuz.
 */
export function formatContext(d) {
  const lines = [];
  lines.push(`nickname: ${d.nickname || 'none'}`);
  lines.push(`language: ${LANGUAGE[d.locale] ?? 'English'}`);
  lines.push(`local_time: ${d.localTime} (${d.tz})`);
  lines.push(
    d.plan
      ? `plan: ${d.plan.displayName}${d.plan.eatWindow ? `, eating window ${d.plan.eatWindow.start}-${d.plan.eatWindow.end}` : ''}`
      : 'plan: none',
  );
  if (d.fast) {
    const stage = d.fast.stage?.title ? `, stage "${clean(d.fast.stage.title)}"` : '';
    lines.push(
      `active_fast: started ${clock(d.fast.startedAt, d.tz)}, elapsed ${hm(d.fast.elapsedMinutes)} of ${hm(d.fast.targetMinutes)}${stage}`,
    );
  } else if (d.eatingWindow) {
    lines.push(
      `active_fast: none (eating window until ${clock(d.eatingWindow.endsAt, d.tz)}, last fast ended ${clock(d.eatingWindow.startedAt, d.tz)})`,
    );
  } else {
    lines.push('active_fast: none');
  }
  lines.push(`streak_days: ${d.streakDays ?? 0}`);
  const goal = [GOALS[d.goal] ?? 'not set'];
  if (d.weightKg && d.goalWeightKg) goal.push(`(${d.weightKg} kg → ${d.goalWeightKg} kg)`);
  lines.push(`goal: ${goal.join(' ')}${d.diet ? `, diet: ${d.diet}` : ''}`);
  if (d.dislikes?.length) lines.push(`dislikes: ${d.dislikes.join(', ')}`);
  const today = [
    `water ${d.today.waterMl}/${d.today.waterGoalMl ?? '?'} ml`,
    `meals ${d.today.meals}${d.today.kcal ? ` (${d.today.kcal} kcal)` : ''}`,
    `steps ${d.today.steps}`,
    `last hunger check: ${d.lastHunger ?? 'none'}`,
  ];
  lines.push(`today: ${today.join(', ')}`);
  lines.push(`safety: ${d.safety.length ? d.safety.join(', ') : 'none'}`);
  lines.push(`entry_point: ${d.entryPoint}`);
  return `<user_context>\n${lines.join('\n')}\n</user_context>`;
}

/**
 * Bağlam verisini toplar. Bağımlılıklar: oruç (aktif oruç + evre), plan ve istatistik servisleri.
 */
export function createContextLoader({ db, fasting, plans, stats }) {
  async function lastHunger(userId, date) {
    const row = await db.one(
      `SELECT result_type, safety_flag FROM hunger_checkins
        WHERE user_id = :userId AND local_date = :date AND deleted_at IS NULL
        ORDER BY logged_at DESC LIMIT 1`,
      { userId: toBin(userId), date },
    );
    return row ? `${row.result_type}${row.safety_flag ? ' (with warning symptoms)' : ''}` : null;
  }

  async function entryPoint(conversation) {
    if (conversation.contextSource !== 'hunger_result' || !conversation.contextRef) {
      return conversation.contextSource ?? 'direct';
    }
    const row = await db.one(
      'SELECT result_type FROM hunger_checkins WHERE id = :id AND user_id = :userId',
      { id: toBin(conversation.contextRef), userId: toBin(conversation.userId) },
    );
    return row ? `hunger_result(${row.result_type})` : 'hunger_result';
  }

  return {
    async build(userId, conversation, locale) {
      const user = await userRepo.getUserWithUnits(db, userId);
      const tz = isValidTimezone(user?.timezone) ? user.timezone : 'UTC';
      const now = new Date();
      const today = localDate(now, tz);
      const [profile, current, active, progress, days, hunger, entry] = await Promise.all([
        userRepo.getProfile(db, userId),
        plans.current(userId, locale),
        fasting.active(userId, locale),
        stats.progress(userId),
        summariesBetween(db, userId, { from: today, to: today }),
        lastHunger(userId, today),
        entryPoint(conversation),
      ]);
      const day = days.get(today);
      const flags = (profile?.health_flags ?? '').split(',').filter(Boolean);
      const age = ageFromBirthYear(profile?.birth_year, today);
      if (age !== null && age < 18 && !flags.includes('under_18')) flags.push('under_18');
      const goals = await userRepo.getGoals(db, userId);
      return formatContext({
        nickname: clean(user?.display_name?.split(/\s+/)[0], 30),
        locale,
        tz,
        localTime: DateTime.fromJSDate(now, { zone: tz }).toFormat('yyyy-MM-dd HH:mm'),
        plan: current.plan,
        fast: active.fast,
        eatingWindow: active.eatingWindow,
        streakDays: progress.streakDays,
        goal: profile?.goal,
        weightKg: profile?.current_weight_kg ?? profile?.start_weight_kg,
        goalWeightKg: profile?.goal_weight_kg,
        diet: profile?.diet ? toApiEnum(profile.diet) : null,
        dislikes: (profile?.food_skips ?? []).map((f) => toApiEnum(f)).slice(0, 8),
        today: {
          waterMl: day?.water_ml ?? 0,
          waterGoalMl: goals?.water_goal_ml ?? null,
          meals: (day?.meals_count ?? 0) + (day?.snacks_count ?? 0),
          kcal: day?.kcal ?? 0,
          steps: day?.steps ?? 0,
        },
        lastHunger: hunger,
        safety: flags,
        entryPoint: entry,
      });
    },
  };
}
