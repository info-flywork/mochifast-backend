import { DateTime } from 'luxon';
import { fromBin } from '../../shared/ids.js';
import { localDate } from '../../shared/time.js';
import { markZoneDays, pendingZoneDays } from '../../shared/zone-days.js';
import * as notify from './notify.js';
import { atLocal, waterSlots } from './notifications.rules.js';

const STREAK_NUDGE_AT = '20:00';
const PLANNER_JOB = 'notification-planner';

/**
 * Günlük hatırlatıcılar (docs/backend/10-bildirimler.md §4.2–4.4): yerel günü henüz planlanmamış
 * saat dilimlerinde (gün dönümünden sonraki ilk saatlik çalışma; shared/zone-days.js), push cihazı olan kullanıcılar için o günün su, kilo, seri dürtmesi ve oruç
 * başlatma hatırlatmaları planlanır. Gönderim anındaki geçerlilik kontrolü (ör. su içildi mi)
 * gönderim işindedir; burada yalnızca zaman.
 * @returns planlanan kullanıcı sayısı
 */
export async function planDailyReminders(db, { now = new Date(), limit = 2000 } = {}) {
  const zoneDays = await pendingZoneDays(
    db,
    PLANNER_JOB,
    (await db.many('SELECT DISTINCT timezone FROM users WHERE deleted_at IS NULL')).map(
      (r) => r.timezone,
    ),
    now,
  );
  if (zoneDays.length === 0) return 0;
  const zones = zoneDays.map((z) => z.timezone);

  const params = Object.fromEntries(zones.map((tz, i) => [`z${i}`, tz]));
  const users = await db.many(
    `SELECT u.id, u.timezone, s.notif_water, s.water_reminder_interval_min,
            TIME_FORMAT(g.wake_time, '%H:%i') AS wake_time, TIME_FORMAT(g.bedtime, '%H:%i') AS bedtime,
            st.current_streak,
            (SELECT MAX(recorded_at) FROM weight_entries w
              WHERE w.user_id = u.id AND w.deleted_at IS NULL) AS last_weight_at,
            (SELECT TIME_FORMAT(up.eat_window_end, '%H:%i') FROM user_plans up
              WHERE up.user_id = u.id AND up.ended_at IS NULL) AS eat_end
       FROM users u
       LEFT JOIN user_settings s ON s.user_id = u.id
       LEFT JOIN user_goals g ON g.user_id = u.id
       LEFT JOIN user_stats st ON st.user_id = u.id
      WHERE u.deleted_at IS NULL AND u.status = 'active'
        AND u.timezone IN (${zones.map((_, i) => `:z${i}`).join(', ')})
        AND EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id
                     AND d.push_token IS NOT NULL AND d.push_enabled = 1)
      LIMIT :limit`,
    { ...params, limit: String(limit) },
  );

  for (const u of users) {
    const userId = fromBin(u.id);
    const tz = u.timezone;
    const today = localDate(now, tz);
    const plan = [];
    if (u.notif_water) {
      for (const slot of waterSlots(u.wake_time, u.bedtime, u.water_reminder_interval_min ?? 120)) {
        plan.push({
          type: 'water_reminder',
          fireAt: atLocal(today, slot, tz, { after: now }),
          dedupeKey: `water:${today}:${slot}`,
        });
      }
    }
    if ((u.current_streak ?? 0) >= 2) {
      plan.push({
        type: 'streak_nudge',
        fireAt: atLocal(today, STREAK_NUDGE_AT, tz),
        params: { streak: u.current_streak },
        dedupeKey: `streak_nudge:${today}`,
      });
    }
    // Haftalık tartı: son tartının günün aynı saatinde, 7 gün dolduysa.
    if (u.last_weight_at && now - u.last_weight_at >= 6 * 86_400_000) {
      const t = DateTime.fromJSDate(u.last_weight_at, { zone: tz }).toFormat('HH:mm');
      plan.push({
        type: 'weight_reminder',
        fireAt: atLocal(today, t, tz),
        dedupeKey: `weight_reminder:${today}`,
      });
    }
    if (u.eat_end) {
      plan.push({
        type: 'fast_start_reminder',
        fireAt: atLocal(today, u.eat_end, tz),
        dedupeKey: `fast_start:${today}`,
      });
    }
    const due = plan.filter((n) => n.fireAt > now);
    if (due.length === 0) continue;
    await db.withTransaction(async (conn) => {
      for (const n of due) await notify.schedule(db, conn, userId, n);
    });
  }
  // Sınıra takıldıysa dilimler işaretlenmez: kalan kullanıcılar sonraki saatte planlanır
  // (dedupe anahtarları tekrarları engeller).
  if (users.length < limit) await markZoneDays(db, PLANNER_JOB, zoneDays);
  return users.length;
}

/** Bakım (10 §6): 60 gün görünmeyen cihazın token'ı, 30 günden eski teslim ve kapanmış planlar. */
export async function notificationHousekeeping(db) {
  const tokens = await db.run(
    `UPDATE devices SET push_token = NULL
      WHERE push_token IS NOT NULL AND COALESCE(last_seen_at, created_at) < DATE_SUB(NOW(3), INTERVAL 60 DAY)`,
  );
  const deliveries = await db.run(
    'DELETE FROM push_deliveries WHERE created_at < DATE_SUB(NOW(3), INTERVAL 30 DAY) LIMIT 5000',
  );
  const scheduled = await db.run(
    `DELETE FROM scheduled_notifications
      WHERE status IN ('sent', 'cancelled', 'skipped', 'failed')
        AND updated_at < DATE_SUB(NOW(3), INTERVAL 30 DAY) LIMIT 5000`,
  );
  return {
    tokensCleared: tokens.affectedRows,
    deliveriesDeleted: deliveries.affectedRows,
    scheduledDeleted: scheduled.affectedRows,
  };
}
