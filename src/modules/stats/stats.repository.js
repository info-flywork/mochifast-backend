import { toBin } from '../../shared/ids.js';
import { isoDate } from '../../shared/time.js';
import { toUserPlan } from '../plans/plans.repository.js';

/** Sayaçlara giren seanslar: bitmiş, silinmemiş. */
const FINISHED = "deleted_at IS NULL AND status IN ('completed', 'ended_early')";
const EPOCH = '1000-01-01';
/** Su hedefi tutturulan gün (05 §12): o günün hedef anlık görüntüsüyle karşılaştırılır. */
const WATER_GOAL_DAY = 'water_goal_ml IS NOT NULL AND water_ml >= water_goal_ml';
/**
 * Ara öğün: türü "snack" ya da türü yokken dilimi "snack" olan kayıt. COALESCE ile NULL'a karşı
 * güvenli: türü ve dilimi olmayan kayıt öğün sayılır (NULL karşılaştırması iki sayımdan da düşerdi).
 */
const SNACK = "(COALESCE(kind, slot, '') = 'snack')";
/** Kullanıcı sayaçları (alt sorgular; `:userId` gerektirir). */
/**
 * Zirve bölgesi (05 §7.1): ulaşılan EN İYİ değişim. Kilo verme hedefinde başlangıç − en düşük
 * ölçüm; hedef başlangıçtan büyükse (kilo alma) en yüksek ölçüm − başlangıç. Negatif olmaz.
 * Profil sütunları tek satırdır; MAX() yalnızca ONLY_FULL_GROUP_BY için.
 */
const BEST_WEIGHT = `(SELECT GREATEST(0, CASE WHEN MAX(p.goal_weight_kg) > MAX(p.start_weight_kg)
                                  THEN MAX(w.weight_kg) - MAX(p.start_weight_kg)
                                  ELSE MAX(p.start_weight_kg) - MIN(w.weight_kg) END)
                       FROM weight_entries w JOIN user_profiles p ON p.user_id = w.user_id
                      WHERE w.user_id = :userId AND w.deleted_at IS NULL
                        AND p.start_weight_kg IS NOT NULL) AS best_weight_lost_kg`;
const COUNTERS = `(SELECT COUNT(*) FROM daily_summaries
                    WHERE user_id = :userId AND ${WATER_GOAL_DAY}) AS water_goal_days,
                  (SELECT COUNT(*) FROM meals
                    WHERE user_id = :userId AND deleted_at IS NULL) AS meals_logged,
                  ${BEST_WEIGHT}`;

export async function userTimezone(db, userId, conn, { lock = false } = {}) {
  const row = await db.one(
    `SELECT timezone FROM users WHERE id = :id${lock ? ' FOR UPDATE' : ''}`,
    { id: toBin(userId) },
    conn,
  );
  return row ? row.timezone : null;
}

export async function getStats(db, userId, conn) {
  return db.one(
    `SELECT current_streak, best_streak, streak_last_date, completed_fasts, total_fasts,
            total_fasted_minutes, longest_fast_minutes, meals_logged, water_goal_days, xp, level,
            best_weight_lost_kg, world_health
       FROM user_stats WHERE user_id = :id`,
    { id: toBin(userId) },
    conn,
  );
}

/** Kullanıcı planları, başlangıç gününe göre artan (gün çözücü için). */
export async function planHistory(db, userId, conn) {
  const rows = await db.many(
    `SELECT up.id, p.code AS plan_code, up.timing, up.fast_minutes, up.eat_window_start,
            up.eat_window_end, CAST(up.weekly_schedule AS CHAR) AS weekly_schedule,
            up.safety_ack_at, up.started_on, up.ended_at
       FROM user_plans up
       JOIN fasting_plans p ON p.id = up.plan_id
      WHERE up.user_id = :userId
      ORDER BY up.started_on, up.created_at`,
    { userId: toBin(userId) },
    conn,
  );
  return rows.map((r) => ({ ...toUserPlan(r), startedOn: isoDate(r.started_on) }));
}

/**
 * `from` gününden itibaren oruç sütunlarını seanslardan yeniden yazar. Diğer sütunlar (su,
 * öğün…) korunur. Hedef, o günün planından anlık görüntü olarak saklanır.
 */
export async function rebuildFastingDays(db, conn, userId, from, resolveDay) {
  const params = { userId: toBin(userId), from: from ?? EPOCH };
  await db.run(
    `UPDATE daily_summaries SET fasted_minutes = 0, fasts_completed = 0
      WHERE user_id = :userId AND local_date >= :from`,
    params,
    conn,
  );
  const days = await db.many(
    `SELECT end_local_date AS d, SUM(duration_minutes) AS minutes,
            SUM(status = 'completed') AS completed
       FROM fasting_sessions
      WHERE user_id = :userId AND ${FINISHED} AND end_local_date >= :from
      GROUP BY end_local_date`,
    params,
    conn,
  );
  const rows = days.map((row) => {
    const date = isoDate(row.d);
    const day = resolveDay(date);
    return {
      date,
      // Bir güne düşen toplam, sütun sınırını (SMALLINT) aşmasın.
      minutes: Math.min(Number(row.minutes), 65_535),
      completed: Math.min(Number(row.completed), 255),
      goal: day.goalMinutes,
      required: day.required ? 1 : 0,
    };
  });
  await insertMany(
    db,
    conn,
    `INSERT INTO daily_summaries
       (user_id, local_date, fasted_minutes, fasts_completed, fast_goal_minutes, is_required_fast_day)
     VALUES {rows}
     ON DUPLICATE KEY UPDATE fasted_minutes = VALUES(fasted_minutes),
       fasts_completed = VALUES(fasts_completed), fast_goal_minutes = VALUES(fast_goal_minutes),
       is_required_fast_day = VALUES(is_required_fast_day)`,
    ['userId', 'date', 'minutes', 'completed', 'goal', 'required'],
    rows.map((r) => ({ ...r, userId: params.userId })),
  );
}

/**
 * Çok satırlı INSERT: `{rows}` yer tutucusu `(:a0, :b0), (:a1, :b1) …` ile değiştirilir.
 * Uzak DB'de satır başına gidiş-dönüşü önler; partiler büyük yeniden hesaplamada da sınırlı kalır.
 */
async function insertMany(db, conn, sql, columns, rows, batch = 500) {
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const params = {};
    const tuples = chunk.map((row, n) => {
      for (const c of columns) params[`${c}${n}`] = row[c] ?? null;
      return `(${columns.map((c) => `:${c}${n}`).join(', ')})`;
    });
    await db.run(sql.replace('{rows}', tuples.join(', ')), params, conn);
  }
}

/** Günlük oruç dakikaları (seri hesabı ve grafikler). */
export async function fastedByDay(db, userId, { from, to } = {}, conn) {
  const rows = await db.many(
    `SELECT local_date, fasted_minutes
       FROM daily_summaries
      WHERE user_id = :userId AND local_date BETWEEN :from AND :to AND fasted_minutes > 0
      ORDER BY local_date`,
    { userId: toBin(userId), from: from ?? EPOCH, to: to ?? '9999-12-31' },
    conn,
  );
  return new Map(rows.map((r) => [isoDate(r.local_date), r.fasted_minutes]));
}

export async function checkinsByDay(db, userId, { from, to } = {}, conn) {
  const rows = await db.many(
    `SELECT local_date, status FROM plan_day_checkins
      WHERE user_id = :userId AND local_date BETWEEN :from AND :to`,
    { userId: toBin(userId), from: from ?? EPOCH, to: to ?? '9999-12-31' },
    conn,
  );
  return new Map(rows.map((r) => [isoDate(r.local_date), r.status]));
}

/**
 * Seri girdileri tek sorguda: oruç dakikası olan günler ve check-in'ler (tarih sıralı).
 */
export async function streakInputs(db, userId, conn) {
  const rows = await db.many(
    `SELECT local_date, fasted_minutes, NULL AS status
       FROM daily_summaries WHERE user_id = :userId AND fasted_minutes > 0
     UNION ALL
     SELECT local_date, NULL, status FROM plan_day_checkins WHERE user_id = :userId
     ORDER BY local_date`,
    { userId: toBin(userId) },
    conn,
  );
  const fasted = new Map();
  const checkins = new Map();
  for (const r of rows) {
    if (r.status) checkins.set(isoDate(r.local_date), r.status);
    else fasted.set(isoDate(r.local_date), r.fasted_minutes);
  }
  return { fasted, checkins };
}

/**
 * Oruç XP olaylarını `from` gününden itibaren seanslardan yeniden üretir (05 §10): silinen ya da
 * iptal edilen seansın puanı düşer, düzenlenenin puanı yeniden hesaplanır. Seri taşları da
 * silinir; seri hesaplandıktan sonra `insertMilestoneXp` ile yeniden yazılır.
 */
export async function rebuildFastXp(db, conn, userId, from, rules) {
  const params = { userId: toBin(userId), from: from ?? EPOCH };
  await db.run(
    `DELETE FROM xp_events
      WHERE user_id = :userId
        AND (reason = 'streak_milestone'
             OR (reason IN ('fast_completed', 'fast_goal_bonus') AND local_date >= :from))`,
    params,
    conn,
  );
  const counted = `user_id = :userId AND ${FINISHED} AND end_local_date >= :from
                   AND duration_minutes >= :minMinutes`;
  await db.run(
    `INSERT INTO xp_events (user_id, reason, ref_key, amount, local_date)
     SELECT user_id, 'fast_completed', LOWER(HEX(id)), :xp, end_local_date
       FROM fasting_sessions WHERE ${counted}
     UNION ALL
     SELECT user_id, 'fast_goal_bonus', LOWER(HEX(id)), :bonusXp, end_local_date
       FROM fasting_sessions
      WHERE ${counted} AND goal_reached = 1 AND target_minutes <= :maxTarget`,
    {
      ...params,
      minMinutes: rules.minMinutes,
      xp: rules.fastXp,
      bonusXp: rules.bonusXp,
      maxTarget: rules.bonusMaxTarget,
    },
    conn,
  );
}

/** Hesaplanan seri kilometre taşlarının XP'si (önceki taşlar `rebuildFastXp`'te silindi). */
export async function insertMilestoneXp(db, conn, userId, milestones) {
  await insertMany(
    db,
    conn,
    'INSERT INTO xp_events (user_id, reason, ref_key, amount, local_date) VALUES {rows}',
    ['userId', 'reason', 'refKey', 'amount', 'date'],
    milestones.map((m) => ({
      userId: toBin(userId),
      reason: 'streak_milestone',
      refKey: `${m.days}:${m.runStart}`,
      amount: m.xp,
      date: m.date,
    })),
  );
}

/**
 * Günlük kazanılan XP'yi olaylardan yeniden yazar. Yalnızca var olan günlere yazılır: oruç
 * yapılmayan güne düşen seri taşı (nötr gün) `xp_events`'te kalır, özete satır açmaz.
 */
export async function rebuildDailyXp(db, conn, userId) {
  await db.run(
    `UPDATE daily_summaries ds
       LEFT JOIN (SELECT local_date, SUM(amount) AS xp FROM xp_events
                   WHERE user_id = :userId GROUP BY local_date) x ON x.local_date = ds.local_date
        SET ds.xp_earned = LEAST(GREATEST(COALESCE(x.xp, 0), 0), 65535)
      WHERE ds.user_id = :userId`,
    { userId: toBin(userId) },
    conn,
  );
}

/** Sayaçlar (05 §1.5) ve XP toplamı: tek GROUP BY. */
export async function totals(db, conn, userId, minMinutes) {
  const row = await db.one(
    `SELECT COALESCE(SUM(status = 'completed'), 0) AS completed_fasts,
            COALESCE(SUM(duration_minutes >= :minMinutes), 0) AS total_fasts,
            COALESCE(SUM(duration_minutes), 0) AS total_fasted_minutes,
            COALESCE(MAX(IF(auto_closed = 0, duration_minutes, 0)), 0) AS longest_fast_minutes,
            MIN(IF(status = 'completed', ended_at, NULL)) AS first_completed_at,
            (SELECT COALESCE(SUM(amount), 0) FROM xp_events WHERE user_id = :userId) AS xp,
            ${COUNTERS}
       FROM fasting_sessions WHERE user_id = :userId AND ${FINISHED}`,
    { userId: toBin(userId), minMinutes },
    conn,
  );
  return {
    firstCompletedAt: row.first_completed_at ?? null,
    completedFasts: Number(row.completed_fasts),
    totalFasts: Number(row.total_fasts),
    totalFastedMinutes: Number(row.total_fasted_minutes),
    longestFastMinutes: Number(row.longest_fast_minutes),
    xp: Math.max(0, Number(row.xp)),
    waterGoalDays: Number(row.water_goal_days),
    mealsLogged: Number(row.meals_logged),
    bestWeightLostKg: Math.round(Number(row.best_weight_lost_kg ?? 0) * 100) / 100,
  };
}

export async function saveStats(db, conn, userId, s) {
  await db.run(
    `INSERT INTO user_stats
       (user_id, current_streak, best_streak, streak_last_date, completed_fasts, total_fasts,
        total_fasted_minutes, longest_fast_minutes, xp, level, first_fast_completed_at,
        water_goal_days, meals_logged, best_weight_lost_kg, world_health)
     VALUES (:userId, :current, :best, :today, :completed, :total, :minutes, :longest, :xp, :level,
             :firstCompletedAt, :waterGoalDays, :mealsLogged, :bestWeight, :health)
     ON DUPLICATE KEY UPDATE current_streak = VALUES(current_streak),
       best_streak = VALUES(best_streak), streak_last_date = VALUES(streak_last_date),
       completed_fasts = VALUES(completed_fasts), total_fasts = VALUES(total_fasts),
       total_fasted_minutes = VALUES(total_fasted_minutes),
       longest_fast_minutes = VALUES(longest_fast_minutes), xp = VALUES(xp), level = VALUES(level),
       water_goal_days = VALUES(water_goal_days), meals_logged = VALUES(meals_logged),
       best_weight_lost_kg = VALUES(best_weight_lost_kg), world_health = VALUES(world_health),
       -- İlk oruç kutlaması bir kez: değer bir kez yazıldıktan sonra silme/düzenleme ile değişmez.
       first_fast_completed_at = COALESCE(first_fast_completed_at, VALUES(first_fast_completed_at))`,
    {
      userId: toBin(userId),
      current: Math.min(s.current, 65_535),
      best: Math.min(s.best, 65_535),
      today: s.today,
      completed: s.completedFasts,
      total: s.totalFasts,
      minutes: s.totalFastedMinutes,
      longest: Math.min(s.longestFastMinutes, 65_535),
      xp: s.xp,
      level: s.level,
      firstCompletedAt: s.firstCompletedAt,
      waterGoalDays: s.waterGoalDays,
      mealsLogged: s.mealsLogged,
      bestWeight: s.bestWeightLostKg,
      health: s.health,
    },
    conn,
  );
}

/** Aralık toplamları (05 §1.5) — `/fasts/stats` ve `/user/stats`. */
export async function rangeTotals(db, userId, { from, to }, minMinutes) {
  const row = await db.one(
    `SELECT COALESCE(SUM(duration_minutes >= :minMinutes), 0) AS fasts,
            COALESCE(SUM(status = 'completed'), 0) AS completed,
            COALESCE(SUM(duration_minutes), 0) AS minutes,
            COALESCE(MAX(IF(auto_closed = 0, duration_minutes, 0)), 0) AS longest
       FROM fasting_sessions
      WHERE user_id = :userId AND ${FINISHED} AND end_local_date BETWEEN :from AND :to`,
    { userId: toBin(userId), from: from ?? EPOCH, to, minMinutes },
  );
  return {
    fasts: Number(row.fasts),
    completed: Number(row.completed),
    minutes: Number(row.minutes),
    longest: Number(row.longest),
  };
}

/** Aylık kovalar (range=all). */
export async function monthlyBuckets(db, userId, { from, to }) {
  const rows = await db.many(
    `SELECT DATE_FORMAT(end_local_date, '%Y-%m') AS month, SUM(duration_minutes) AS minutes,
            SUM(duration_minutes >= 60) AS fasts
       FROM fasting_sessions
      WHERE user_id = :userId AND ${FINISHED} AND end_local_date BETWEEN :from AND :to
      GROUP BY month ORDER BY month`,
    { userId: toBin(userId), from: from ?? EPOCH, to },
  );
  return rows.map((r) => ({
    month: r.month,
    fastedMinutes: Number(r.minutes),
    fasts: Number(r.fasts),
  }));
}

/** Aralıktaki ilk ve son kilo ölçümü (kilo değişimi). */
export async function weightChange(db, userId, { from, to }) {
  const rows = await db.many(
    `(SELECT weight_kg FROM weight_entries
       WHERE user_id = :userId AND deleted_at IS NULL AND local_date BETWEEN :from AND :to
       ORDER BY recorded_at ASC LIMIT 1)
     UNION ALL
     (SELECT weight_kg FROM weight_entries
       WHERE user_id = :userId AND deleted_at IS NULL AND local_date BETWEEN :from AND :to
       ORDER BY recorded_at DESC LIMIT 1)`,
    { userId: toBin(userId), from: from ?? EPOCH, to },
  );
  if (rows.length < 2) return null;
  return Math.round((rows[1].weight_kg - rows[0].weight_kg) * 100) / 100;
}

/** Saat dilimi listesindeki, serisi olan kullanıcılar (gün dönümü işi). */
export async function usersWithStreakIn(db, timezones) {
  if (timezones.length === 0) return [];
  const placeholders = timezones.map((_, i) => `:tz${i}`).join(', ');
  const params = Object.fromEntries(timezones.map((tz, i) => [`tz${i}`, tz]));
  return db.many(
    `SELECT u.id FROM users u JOIN user_stats s ON s.user_id = u.id
      WHERE u.timezone IN (${placeholders}) AND s.current_streak > 0 AND u.deleted_at IS NULL`,
    params,
  );
}

export async function streakTimezones(db) {
  const rows = await db.many(
    `SELECT DISTINCT u.timezone FROM users u JOIN user_stats s ON s.user_id = u.id
      WHERE s.current_streak > 0`,
  );
  return rows.map((r) => r.timezone);
}

/**
 * Son `hours` saatte oruç kaydı ya da günlük özeti değişen kullanıcılar (gece doğrulaması).
 * Takipçi yazmaları özet satırını güncellediği için ikinci kaynak su/adım/uyku/kiloyu kapsar.
 */
export async function usersWithRecentChanges(db, hours) {
  return db.many(
    `SELECT user_id AS id FROM fasting_sessions
      WHERE updated_at >= DATE_SUB(NOW(3), INTERVAL :hours HOUR)
     UNION
     SELECT user_id FROM daily_summaries
      WHERE updated_at >= DATE_SUB(NOW(3), INTERVAL :hours HOUR)`,
    { hours },
  );
}

/** 72 saati geçmiş aktif seanslar (otomatik kapanış). */
export async function staleActiveFasts(db, hours, limit) {
  return db.many(
    `SELECT id, user_id FROM fasting_sessions
      WHERE status = 'active' AND started_at <= DATE_SUB(NOW(3), INTERVAL :hours HOUR)
      ORDER BY started_at LIMIT :limit`,
    { hours, limit: String(limit) },
  );
}

// ── Takipçiler (F4) ───────────────────────────────────────────────────

/**
 * Bir günün takipçi sütunlarını ham kayıtlardan yazar: su, adım, uyku, günün son kilosu,
 * öğün toplamları ve açlık check-in sayıları. Hedefler yazma anındaki kullanıcı hedefinden anlık
 * görüntü olarak saklanır: sonradan hedef değişse de geçmiş günün "hedef tuttu mu" sonucu
 * değişmez. Kalori/protein hedefi yalnızca kullanıcı elle girdiyse saklanır (öneri canlı
 * hesaplanır).
 */
export async function upsertTrackerDay(db, conn, userId, date) {
  const live = 'user_id = :userId AND local_date = :date AND deleted_at IS NULL';
  await db.run(
    `INSERT INTO daily_summaries
       (user_id, local_date, water_ml, water_goal_ml, steps, steps_goal, sleep_minutes,
        sleep_goal_min, weight_kg, kcal, kcal_goal, protein_g, protein_goal_g, carbs_g, fat_g,
        meals_count, snacks_count, hunger_physical, hunger_emotional)
     SELECT * FROM (
     SELECT :userId AS user_id, :date AS local_date,
            LEAST((SELECT COALESCE(SUM(amount_ml), 0) FROM water_entries WHERE ${live}), 16777215)
              AS water_ml,
            g.water_goal_ml,
            (SELECT COALESCE(MAX(steps), 0) FROM step_daily
              WHERE user_id = :userId AND local_date = :date) AS steps,
            g.steps_goal,
            (SELECT LEAST(SUM(duration_minutes), 65535) FROM sleep_entries WHERE ${live})
              AS sleep_minutes,
            g.sleep_goal_min,
            (SELECT weight_kg FROM weight_entries WHERE ${live}
              ORDER BY recorded_at DESC, id DESC LIMIT 1) AS weight_kg,
            LEAST(m.kcal, 65535) AS kcal, g.kcal_goal, LEAST(m.protein, 99999) AS protein_g,
            g.protein_goal_g, LEAST(m.carbs, 99999) AS carbs_g, LEAST(m.fat, 99999) AS fat_g,
            LEAST(m.meals, 255) AS meals_count, LEAST(m.snacks, 255) AS snacks_count,
            LEAST(h.physical, 255) AS hunger_physical, LEAST(h.emotional, 255) AS hunger_emotional
       FROM (SELECT COALESCE(SUM(kcal), 0) AS kcal, COALESCE(SUM(protein_g), 0) AS protein,
                    COALESCE(SUM(carbs_g), 0) AS carbs, COALESCE(SUM(fat_g), 0) AS fat,
                    COALESCE(SUM(${SNACK} = 0), 0) AS meals, COALESCE(SUM(${SNACK}), 0) AS snacks
               FROM meals WHERE ${live}) AS m
      CROSS JOIN (SELECT COALESCE(SUM(result_type = 'physical'), 0) AS physical,
                         COALESCE(SUM(result_type = 'emotional'), 0) AS emotional
                    FROM hunger_checkins WHERE ${live}) AS h
       LEFT JOIN user_goals g ON g.user_id = :userId
     ) AS day
     -- SELECT türetilmiş tabloda: aksi hâlde JOIN'in ON'u ile ON DUPLICATE KEY karışır.
     ON DUPLICATE KEY UPDATE water_ml = VALUES(water_ml), water_goal_ml = VALUES(water_goal_ml),
       steps = VALUES(steps), steps_goal = VALUES(steps_goal),
       sleep_minutes = VALUES(sleep_minutes), sleep_goal_min = VALUES(sleep_goal_min),
       weight_kg = VALUES(weight_kg), kcal = VALUES(kcal), kcal_goal = VALUES(kcal_goal),
       protein_g = VALUES(protein_g), protein_goal_g = VALUES(protein_goal_g),
       carbs_g = VALUES(carbs_g), fat_g = VALUES(fat_g), meals_count = VALUES(meals_count),
       snacks_count = VALUES(snacks_count), hunger_physical = VALUES(hunger_physical),
       hunger_emotional = VALUES(hunger_emotional)`,
    { userId: toBin(userId), date },
    conn,
  );
}

/**
 * Günlük takipçi XP'si (05 §10): su hedefi günü 5, kilo kaydı 3 (ikisi de günde bir), öğün
 * kaydı 2 (günde en fazla 5 öğün), açlık check-in'i 2 (günde en fazla 3).
 * Onboarding kilosu kayıt sayılmaz (kullanıcı tartılıp girmedi, formu doldurdu).
 * `ref_key` gündür; aynı gün tekrar yazılınca olay yinelenmez.
 */
export async function syncTrackerXp(db, conn, userId, date, rules) {
  const params = { userId: toBin(userId), date };
  await db.run(
    `DELETE FROM xp_events
      WHERE user_id = :userId
        AND reason IN ('water_goal', 'weight_logged', 'meal_logged', 'hunger_checkin')
        AND ref_key = :date`,
    params,
    conn,
  );
  await db.run(
    `INSERT INTO xp_events (user_id, reason, ref_key, amount, local_date)
     SELECT user_id, 'water_goal', :date, :waterXp, local_date FROM daily_summaries
      WHERE user_id = :userId AND local_date = :date AND ${WATER_GOAL_DAY}
     UNION ALL
     SELECT :userId, 'weight_logged', :date, :weightXp, :date FROM DUAL
      WHERE EXISTS (SELECT 1 FROM weight_entries
                     WHERE user_id = :userId AND local_date = :date AND deleted_at IS NULL
                       AND source <> 'onboarding')
     UNION ALL
     SELECT user_id, 'meal_logged', :date, :mealXp * LEAST(meals_count + snacks_count, :mealCap),
            local_date
       FROM daily_summaries
      WHERE user_id = :userId AND local_date = :date AND meals_count + snacks_count > 0
     UNION ALL
     SELECT user_id, 'hunger_checkin', :date,
            :hungerXp * LEAST(hunger_physical + hunger_emotional, :hungerCap), local_date
       FROM daily_summaries
      WHERE user_id = :userId AND local_date = :date AND hunger_physical + hunger_emotional > 0`,
    {
      ...params,
      waterXp: rules.waterGoalXp,
      weightXp: rules.weightXp,
      mealXp: rules.mealXp,
      mealCap: rules.mealCap,
      hungerXp: rules.hungerXp,
      hungerCap: rules.hungerCap,
    },
    conn,
  );
  await db.run(
    `UPDATE daily_summaries
        SET xp_earned = (SELECT LEAST(GREATEST(COALESCE(SUM(amount), 0), 0), 65535)
                           FROM xp_events WHERE user_id = :userId AND local_date = :date)
      WHERE user_id = :userId AND local_date = :date`,
    params,
    conn,
  );
}

/** XP toplamı ve takipçi sayaçları (takipçi yazmasından sonra hafif güncelleme). */
export async function trackerCounters(db, conn, userId) {
  const row = await db.one(
    `SELECT (SELECT COALESCE(SUM(amount), 0) FROM xp_events WHERE user_id = :userId) AS xp,
            ${COUNTERS}`,
    { userId: toBin(userId) },
    conn,
  );
  return {
    xp: Math.max(0, Number(row.xp)),
    waterGoalDays: Number(row.water_goal_days),
    mealsLogged: Number(row.meals_logged),
    bestWeightLostKg: Math.round(Number(row.best_weight_lost_kg ?? 0) * 100) / 100,
  };
}

export async function saveXp(
  db,
  conn,
  userId,
  { xp, level, waterGoalDays, mealsLogged, bestWeightLostKg },
) {
  await db.run(
    `INSERT INTO user_stats (user_id, xp, level, water_goal_days, meals_logged, best_weight_lost_kg)
     VALUES (:userId, :xp, :level, :waterGoalDays, :mealsLogged, :bestWeight)
     ON DUPLICATE KEY UPDATE xp = VALUES(xp), level = VALUES(level),
       water_goal_days = VALUES(water_goal_days), meals_logged = VALUES(meals_logged),
       best_weight_lost_kg = VALUES(best_weight_lost_kg)`,
    {
      userId: toBin(userId),
      xp,
      level,
      waterGoalDays,
      mealsLogged,
      bestWeight: bestWeightLostKg ?? 0,
    },
    conn,
  );
}

/** `from`'dan itibaren takipçi kaydı olan ya da özetinde takipçi değeri kalan günler. */
export async function trackerDates(db, userId, from, conn) {
  const rows = await db.many(
    `SELECT local_date FROM water_entries WHERE user_id = :userId AND local_date >= :from
     UNION SELECT local_date FROM step_daily WHERE user_id = :userId AND local_date >= :from
     UNION SELECT local_date FROM sleep_entries WHERE user_id = :userId AND local_date >= :from
     UNION SELECT local_date FROM weight_entries WHERE user_id = :userId AND local_date >= :from
     UNION SELECT local_date FROM meals WHERE user_id = :userId AND local_date >= :from
     UNION SELECT local_date FROM hunger_checkins WHERE user_id = :userId AND local_date >= :from
     UNION SELECT local_date FROM daily_summaries
            WHERE user_id = :userId AND local_date >= :from
              AND (water_ml > 0 OR steps > 0 OR sleep_minutes IS NOT NULL OR weight_kg IS NOT NULL
                   OR kcal > 0 OR meals_count > 0 OR snacks_count > 0
                   OR hunger_physical > 0 OR hunger_emotional > 0)`,
    { userId: toBin(userId), from: from ?? EPOCH },
    conn,
  );
  return rows.map((r) => isoDate(r.local_date)).sort();
}

/** Aralıkta su hedefi tutturulan gün sayısı. */
export async function waterGoalDays(db, userId, { from, to }) {
  const row = await db.one(
    `SELECT COUNT(*) AS n FROM daily_summaries
      WHERE user_id = :userId AND local_date BETWEEN :from AND :to AND ${WATER_GOAL_DAY}`,
    { userId: toBin(userId), from: from ?? EPOCH, to },
  );
  return Number(row.n);
}

/** Aralıkta kaydedilen öğün sayısı. */
export async function mealsLogged(db, userId, { from, to }) {
  const row = await db.one(
    `SELECT COUNT(*) AS n FROM meals
      WHERE user_id = :userId AND deleted_at IS NULL AND local_date BETWEEN :from AND :to`,
    { userId: toBin(userId), from: from ?? EPOCH, to },
  );
  return Number(row.n);
}
