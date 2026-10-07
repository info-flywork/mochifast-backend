/**
 * Mochi World eşikleri ve challenge kataloğu (seeds/gamification.json). İdempotent:
 * eşikler tamamen yeniden yazılır; challenge'lar koda göre upsert edilir, seed'den çıkarılan
 * challenge silinmez, pasifleşir (katılımlar ona bağlı).
 */
export async function seedGamification(db, conn, seed) {
  await db.run('DELETE FROM world_zone_thresholds', {}, conn);
  for (const [zone, thresholds] of Object.entries(seed.zones)) {
    for (const [i, threshold] of thresholds.entries()) {
      await db.run(
        'INSERT INTO world_zone_thresholds (zone, level, threshold) VALUES (:zone, :level, :threshold)',
        { zone, level: i + 1, threshold },
        conn,
      );
    }
  }

  const codes = [];
  for (const c of seed.challenges) {
    codes.push(c.code);
    await db.run(
      `INSERT INTO challenges
         (code, metric, target_count, duration_days, window_type, starts_at, ends_at, is_premium,
          is_featured, reward_xp, sort_order, is_active)
       VALUES (:code, :metric, :target, :days, :windowType, :startsAt, :endsAt, :premium,
               :featured, :xp, :sort, 1)
       ON DUPLICATE KEY UPDATE metric = VALUES(metric), target_count = VALUES(target_count),
         duration_days = VALUES(duration_days), window_type = VALUES(window_type),
         starts_at = VALUES(starts_at), ends_at = VALUES(ends_at), is_premium = VALUES(is_premium),
         is_featured = VALUES(is_featured), reward_xp = VALUES(reward_xp),
         sort_order = VALUES(sort_order), is_active = 1`,
      {
        code: c.code,
        metric: c.metric,
        target: c.targetCount,
        days: c.durationDays,
        windowType: c.windowType ?? 'rolling',
        startsAt: c.startsAt ? new Date(c.startsAt) : null,
        endsAt: c.endsAt ? new Date(c.endsAt) : null,
        premium: c.isPremium ? 1 : 0,
        featured: c.isFeatured ? 1 : 0,
        xp: c.rewardXp ?? 50,
        sort: c.sortOrder ?? 0,
      },
      conn,
    );
    const { id } = await db.one(
      'SELECT id FROM challenges WHERE code = :code',
      { code: c.code },
      conn,
    );
    await db.run('DELETE FROM challenge_translations WHERE challenge_id = :id', { id }, conn);
    for (const [locale, t] of Object.entries(c.translations)) {
      await db.run(
        `INSERT INTO challenge_translations (challenge_id, locale, title, subtitle, badge_label, description)
         VALUES (:id, :locale, :title, :subtitle, :badge, :description)`,
        {
          id,
          locale,
          title: t.title,
          subtitle: t.subtitle,
          badge: t.badge ?? null,
          description: t.description ?? null,
        },
        conn,
      );
    }
  }
  const placeholders = codes.map((_, i) => `:c${i}`).join(', ');
  const deactivated = await db.run(
    `UPDATE challenges SET is_active = 0 WHERE is_active = 1 AND code NOT IN (${placeholders})`,
    Object.fromEntries(codes.map((c, i) => [`c${i}`, c])),
    conn,
  );
  return { challenges: codes.length, challengesDeactivated: deactivated.affectedRows };
}
