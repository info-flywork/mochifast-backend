/**
 * Raporlar (04 §19): kayıt, aktif kullanıcı, huni, oruç tamamlama, AI maliyeti, premium.
 * Günler UTC'dir. Sorgular aralıkla sınırlı ve indeksli; ağırlaşırsa read replica'ya taşınır
 * (07 §6).
 */
const DAY_MS = 86_400_000;

const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Eksik günleri 0 ile doldurur. */
function series(rows, from, to, fields) {
  const byDay = new Map(rows.map((r) => [isoDay(r.day), r]));
  const out = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    const r = byDay.get(day);
    out.push({ date: day, ...Object.fromEntries(fields.map((f) => [f, Number(r?.[f] ?? 0)])) });
  }
  return out;
}

export function createAdminReports({ db }) {
  return {
    /** @param days 1–365 (bugün dahil) */
    async overview({ days = 30 } = {}) {
      const to = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
      const from = new Date(to.getTime() - (days - 1) * DAY_MS);
      const range = { from, toEnd: new Date(to.getTime() + DAY_MS) };

      const [signups, active, fasts, ai, subs, funnel, totals] = await Promise.all([
        db.many(
          `SELECT DATE(created_at) AS day, COUNT(*) AS total, SUM(is_guest = 0) AS registered
             FROM users WHERE created_at >= :from AND created_at < :toEnd
            GROUP BY DATE(created_at)`,
          range,
        ),
        db.many(
          `SELECT activity_date AS day, COUNT(*) AS users FROM user_activity_daily
            WHERE activity_date >= :from AND activity_date < :toEnd GROUP BY activity_date`,
          range,
        ),
        db.many(
          `SELECT DATE(started_at) AS day, COUNT(*) AS started,
                  SUM(status = 'completed') AS completed, SUM(status = 'ended_early') AS ended_early
             FROM fasting_sessions
            WHERE started_at >= :from AND started_at < :toEnd AND deleted_at IS NULL
            GROUP BY DATE(started_at)`,
          range,
        ),
        db.many(
          `SELECT usage_date AS day, SUM(requests) AS requests,
                  SUM(cost_micro_usd) AS cost_micro_usd
             FROM ai_usage_daily WHERE usage_date >= :from AND usage_date < :toEnd
            GROUP BY usage_date`,
          range,
        ),
        db.many(
          `SELECT DATE(purchased_at) AS day, COUNT(*) AS new_subscriptions
             FROM subscriptions
            WHERE purchased_at >= :from AND purchased_at < :toEnd
              AND (store IS NULL OR store <> 'promotional')
            GROUP BY DATE(purchased_at)`,
          range,
        ),
        // Aralıkta oluşan hesapların hunisi.
        db.one(
          `SELECT COUNT(*) AS created,
                  SUM(onboarding_completed_at IS NOT NULL) AS onboarded,
                  SUM(is_guest = 0) AS registered,
                  SUM(EXISTS (SELECT 1 FROM subscriptions s
                               WHERE s.user_id = u.id AND s.store <> 'promotional')) AS subscribed
             FROM users u WHERE created_at >= :from AND created_at < :toEnd`,
          range,
        ),
        db.one(
          `SELECT
             (SELECT COUNT(*) FROM users WHERE status = 'active') AS users,
             (SELECT COUNT(DISTINCT user_id) FROM user_activity_daily
               WHERE activity_date >= DATE_SUB(UTC_DATE(), INTERVAL 6 DAY)) AS wau,
             (SELECT COUNT(DISTINCT user_id) FROM user_activity_daily
               WHERE activity_date >= DATE_SUB(UTC_DATE(), INTERVAL 29 DAY)) AS mau,
             (SELECT COUNT(*) FROM user_activity_daily WHERE activity_date = UTC_DATE()) AS dau,
             (SELECT COUNT(*) FROM subscriptions
               WHERE status IN ('active', 'in_grace', 'billing_issue')
                 AND (expires_at IS NULL OR expires_at > NOW(3))
                 AND (store IS NULL OR store <> 'promotional')) AS paying,
             (SELECT COUNT(*) FROM subscriptions
               WHERE status IN ('active', 'in_grace', 'billing_issue')
                 AND (expires_at IS NULL OR expires_at > NOW(3))) AS premium`,
        ),
      ]);

      const created = Number(funnel.created ?? 0);
      const rate = (n) => (created > 0 ? Number((Number(n ?? 0) / created).toFixed(4)) : 0);
      const aiSeries = series(ai, from, to, ['requests', 'cost_micro_usd']).map((d) => ({
        date: d.date,
        requests: d.requests,
        costUsd: d.cost_micro_usd / 1e6,
      }));
      return {
        range: { from: isoDay(from), to: isoDay(to), days },
        totals: {
          users: Number(totals.users),
          dau: Number(totals.dau),
          wau: Number(totals.wau),
          mau: Number(totals.mau),
          premium: Number(totals.premium),
          paying: Number(totals.paying),
          aiCostUsd: aiSeries.reduce((a, d) => a + d.costUsd, 0),
        },
        funnel: {
          created,
          onboarded: Number(funnel.onboarded ?? 0),
          registered: Number(funnel.registered ?? 0),
          subscribed: Number(funnel.subscribed ?? 0),
          onboardedRate: rate(funnel.onboarded),
          registeredRate: rate(funnel.registered),
          subscribedRate: rate(funnel.subscribed),
        },
        daily: {
          signups: series(signups, from, to, ['total', 'registered']),
          activeUsers: series(active, from, to, ['users']),
          fasts: series(fasts, from, to, ['started', 'completed', 'ended_early']).map((d) => ({
            date: d.date,
            started: d.started,
            completed: d.completed,
            endedEarly: d.ended_early,
            completionRate: d.started > 0 ? Number((d.completed / d.started).toFixed(4)) : 0,
          })),
          ai: aiSeries,
          newSubscriptions: series(subs, from, to, ['new_subscriptions']).map((d) => ({
            date: d.date,
            count: d.new_subscriptions,
          })),
        },
      };
    },
  };
}
