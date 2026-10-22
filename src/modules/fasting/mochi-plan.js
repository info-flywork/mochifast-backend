import { setTimeout as sleep } from 'node:timers/promises';
import { DateTime } from 'luxon';
import { toBin } from '../../shared/ids.js';
import { addDays, isValidTimezone, isoDate, localDate } from '../../shared/time.js';
import { ageFromBirthYear } from '../user/onboarding.rules.js';

/**
 * Mochi'nin bugünkü önerisi. Aktif orucun veya kayıtlı planın kopyası değildir:
 * hedef, uyku, adım, son oruçlar ve zorlanmalardan seçilir.
 * AI yalnızca süreyi en fazla 2 saat oynatır ve gerekçeyi yazar; süre kuralı
 * beklenmeden de döner, metin arka planda önbelleğe yazılır.
 */

const GENTLE = new Set(['pregnant', 'breastfeeding', 'under_18', 'eating_disorder_history']);
const MEDICAL = new Set(['diabetes', 'medication', 'heart_condition']);

const LANGUAGE = {
  en: 'English',
  tr: 'Turkish',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  ru: 'Russian',
};

/** AI yanıtını beklerken ekranın kural planıyla açılması için üst süre. */
const AI_WAIT_MS = 2500;

export function roundToHalfHour(minutes) {
  const rounded = Math.round(minutes / 30) * 30;
  return ((rounded % 1440) + 1440) % 1440;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * @returns {{ fastHours: number, eatHours: number, startMinutes: number, reason: string, minHours: number, maxHours: number }}
 */
export function recommendFast({
  goal = null,
  healthFlags = [],
  age = null,
  sleepMinutes = null,
  stepsYesterday = null,
  stepsGoal = null,
  fastsEnded = 0,
  fastsReached = 0,
  struggles = 0,
  typicalStartMinutes = null,
} = {}) {
  const flags = new Set(healthFlags);
  const minor = flags.has('under_18') || (age !== null && age < 18);
  if (minor) flags.add('under_18');
  const gentle = [...flags].some((flag) => GENTLE.has(flag));
  const medical = [...flags].some((flag) => MEDICAL.has(flag));

  let minHours = 12;
  let maxHours = 18;
  if (gentle) {
    minHours = 12;
    maxHours = 12;
  } else if (medical) {
    maxHours = 14;
  }

  let hours = goal === 'lose_weight' ? 16 : 14;
  let reason = goal === 'lose_weight' ? 'weight_goal' : 'steady';

  if (gentle || medical) {
    hours = gentle ? 12 : Math.min(hours, 14);
    reason = 'safety';
  } else {
    const shortSleep = sleepMinutes !== null && sleepMinutes < 360;
    const veryShortSleep = sleepMinutes !== null && sleepMinutes < 300;
    const hardDay =
      stepsYesterday !== null && stepsYesterday >= Math.max(12000, (stepsGoal ?? 0) * 1.4);
    const lowCompletion = fastsEnded >= 2 && fastsReached / fastsEnded < 0.5;
    const ready =
      fastsEnded >= 4 &&
      fastsReached / fastsEnded >= 0.8 &&
      struggles === 0 &&
      (sleepMinutes === null || sleepMinutes >= 420);

    if (veryShortSleep) hours -= 4;
    else if (shortSleep) hours -= 2;
    if (struggles >= 2) hours -= 2;
    if (lowCompletion) hours -= 2;
    if (hardDay) hours -= 2;
    if (ready) hours += 2;

    if (veryShortSleep || shortSleep) reason = 'short_sleep';
    else if (struggles >= 2) reason = 'struggles';
    else if (lowCompletion) reason = 'low_completion';
    else if (hardDay) reason = 'hard_day';
    else if (ready) reason = 'ready_longer';
  }

  hours = Math.min(maxHours, Math.max(minHours, hours));
  const startMinutes = roundToHalfHour(typicalStartMinutes ?? 20 * 60);
  return {
    fastHours: hours,
    eatHours: 24 - hours,
    startMinutes,
    reason,
    minHours,
    maxHours,
  };
}

/** Modelin süresini kuralın ±2 saatine ve güvenlik sınırına çeker. */
export function clampAiHours(ruleHours, aiHours, minHours, maxHours) {
  if (!Number.isInteger(aiHours)) return ruleHours;
  const lo = Math.max(minHours, ruleHours - 2);
  const hi = Math.min(maxHours, ruleHours + 2);
  return Math.min(hi, Math.max(lo, aiHours));
}

export function parseAiPlan(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const json = JSON.parse(text.slice(start, end + 1));
    const hours = Number(json.fastHours);
    const insight =
      typeof json.insight === 'string'
        ? json.insight.replace(/\s+/g, ' ').trim().slice(0, 180)
        : '';
    return {
      fastHours: Number.isInteger(hours) ? hours : null,
      insight: insight || null,
    };
  } catch {
    return null;
  }
}

function windowOn(day, tz, startMinutes, fastHours) {
  const startsAt = DateTime.fromISO(day, { zone: tz }).plus({ minutes: startMinutes }).toJSDate();
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + fastHours * 60 * 60 * 1000),
  };
}

function toDto(rule, { day, tz, insight = null }) {
  const window = windowOn(day, tz, rule.startMinutes, rule.fastHours);
  return {
    fastHours: rule.fastHours,
    eatHours: rule.eatHours,
    startsAt: window.startsAt.toISOString(),
    endsAt: window.endsAt.toISOString(),
    insight,
    reason: rule.reason,
  };
}

function secondsUntilNextDay(day, tz, now) {
  const end = DateTime.fromISO(day, { zone: tz }).plus({ days: 1 });
  const sec = Math.floor((end.toMillis() - now.getTime()) / 1000);
  return Math.max(60, Math.min(sec, 86_400));
}

function aiMessages(rule, signals, locale) {
  const language = LANGUAGE[locale] ?? 'English';
  const facts = [
    `goal: ${signals.goal ?? 'unset'}`,
    `sleep_last_nights_minutes: ${signals.sleepMinutes ?? 'unknown'}`,
    `steps_yesterday: ${signals.stepsYesterday ?? 'unknown'} of goal ${signals.stepsGoal ?? 'unknown'}`,
    `recent_fasts: ${signals.fastsReached}/${signals.fastsEnded} reached the goal`,
    `struggles_last_3_days: ${signals.struggles}`,
    `chosen_fast_hours: ${rule.fastHours} (eating ${rule.eatHours})`,
    `allowed_fast_hours: ${rule.minHours}-${rule.maxHours}`,
    `reason: ${rule.reason}`,
  ].join('\n');
  return [
    {
      role: 'system',
      content:
        'You are Mochi, a warm fasting coach. Reply with JSON only: {"fastHours": number, "insight": string}. ' +
        `fastHours must stay within the allowed range and within 2 hours of chosen_fast_hours. ` +
        `insight is one short second-person sentence in ${language}, no diagnosis, no emoji, under 140 characters.`,
    },
    { role: 'user', content: facts },
  ];
}

export function createMochiPlanService({ db, chat = null, cache = null, now = () => new Date() }) {
  const inflight = new Map();

  async function loadSignals(userId, tz, day) {
    const id = toBin(userId);
    const from = addDays(day, -6);
    const yesterday = addDays(day, -1);
    const [profile, days, fasts, struggleRow] = await Promise.all([
      db.one(`SELECT goal, health_flags, birth_year FROM user_profiles WHERE user_id = :id`, {
        id,
      }),
      db.many(
        `SELECT local_date, sleep_minutes, steps, steps_goal
           FROM daily_summaries
          WHERE user_id = :id AND local_date BETWEEN :from AND :to`,
        { id, from, to: day },
      ),
      db.many(
        `SELECT started_at, goal_reached FROM fasting_sessions
          WHERE user_id = :id AND deleted_at IS NULL
            AND status IN ('completed', 'ended_early')
          ORDER BY started_at DESC LIMIT 7`,
        { id },
      ),
      db.one(
        `SELECT COUNT(*) AS n FROM struggle_events
          WHERE user_id = :id AND created_at >= DATE_SUB(:now, INTERVAL 3 DAY)`,
        { id, now: now() },
      ),
    ]);

    const recentSleep = days
      .filter((row) => isoDate(row.local_date) >= addDays(day, -2))
      .map((row) => Number(row.sleep_minutes) || 0)
      .filter((minutes) => minutes > 0);
    const sleepMinutes = recentSleep.length
      ? Math.round(recentSleep.reduce((sum, n) => sum + n, 0) / recentSleep.length)
      : null;
    const yDay = days.find((row) => isoDate(row.local_date) === yesterday);
    const starts = fasts
      .map((row) => {
        const local = DateTime.fromJSDate(new Date(row.started_at), { zone: tz });
        return local.isValid ? local.hour * 60 + local.minute : null;
      })
      .filter((minutes) => minutes !== null);

    return {
      goal: profile?.goal ?? null,
      healthFlags: String(profile?.health_flags ?? '')
        .split(',')
        .map((flag) => flag.trim())
        .filter(Boolean),
      age: ageFromBirthYear(profile?.birth_year, day),
      sleepMinutes,
      stepsYesterday: yDay ? Number(yDay.steps) || 0 : null,
      stepsGoal: yDay ? Number(yDay.steps_goal) || null : null,
      fastsEnded: fasts.length,
      fastsReached: fasts.filter(
        (row) => Number(row.goal_reached) === 1 || row.goal_reached === true,
      ).length,
      struggles: Number(struggleRow?.n) || 0,
      typicalStartMinutes: median(starts),
    };
  }

  function startJob(key, userId, locale) {
    let publishDraft;
    const draftReady = new Promise((resolve) => {
      publishDraft = resolve;
    });
    const done = (async () => {
      const at = now();
      const user = await db.one('SELECT timezone FROM users WHERE id = :id', { id: toBin(userId) });
      const tz = isValidTimezone(user?.timezone) ? user.timezone : 'UTC';
      const day = localDate(at, tz);
      const signals = await loadSignals(userId, tz, day);
      const rule = recommendFast(signals);
      publishDraft(toDto(rule, { day, tz }));

      let insight = null;
      let fastHours = rule.fastHours;
      if (chat?.enabled) {
        try {
          const res = await chat.complete(aiMessages(rule, signals, locale), {
            maxTokens: 800,
            timeoutMs: 12_000,
          });
          const parsed = res.refusal ? null : parseAiPlan(res.text);
          if (parsed) {
            fastHours = clampAiHours(
              rule.fastHours,
              parsed.fastHours,
              rule.minHours,
              rule.maxHours,
            );
            insight = parsed.insight;
          }
        } catch {
          // Kural planı durur; metin uygulamanın çevirisine düşer.
        }
      }
      const plan = toDto({ ...rule, fastHours, eatHours: 24 - fastHours }, { day, tz, insight });
      await cache?.set(key, plan, secondsUntilNextDay(day, tz, at));
      return plan;
    })().catch((err) => {
      publishDraft(null);
      throw err;
    });
    return { draftReady, done };
  }

  return {
    async mochiPlan(userId, locale = 'en') {
      const at = now();
      const user = await db.one('SELECT timezone FROM users WHERE id = :id', { id: toBin(userId) });
      const tz = isValidTimezone(user?.timezone) ? user.timezone : 'UTC';
      const day = localDate(at, tz);
      const key = `mochi-plan:${userId}:${day}:${locale ?? 'en'}`;
      const hit = await cache?.get(key);
      if (hit) return { plan: { ...hit, settled: true } };

      let job = inflight.get(key);
      if (!job) {
        job = startJob(key, userId, locale ?? 'en');
        inflight.set(key, job);
        job.done.finally(() => {
          if (inflight.get(key) === job) inflight.delete(key);
        });
      }

      const draft = await job.draftReady;
      const quick = await Promise.race([
        job.done.then((plan) => ({ plan, settled: true })),
        sleep(AI_WAIT_MS).then(() => null),
      ]);
      if (quick?.plan) return { plan: { ...quick.plan, settled: true } };
      const cached = await cache?.get(key);
      if (cached) return { plan: { ...cached, settled: true } };
      if (!draft) {
        const fallback = recommendFast();
        return { plan: { ...toDto(fallback, { day, tz }), settled: true } };
      }
      return { plan: { ...draft, settled: false } };
    },
  };
}
