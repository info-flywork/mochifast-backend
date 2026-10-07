/**
 * Bildirim şablonları ve bölge adları (seeds/notifications.json). İdempotent: şablon türüne göre
 * upsert, çeviriler yeniden yazılır; seed'den çıkarılan şablon pasifleşir (eski inbox kayıtları
 * ona bağlı olabilir).
 */
export async function seedNotifications(db, conn, seed) {
  const types = [];
  for (const t of seed.templates) {
    types.push(t.type);
    await db.run(
      `INSERT INTO notification_templates
         (type, channel, category, quiet_hours, max_delay_min, priority, deep_link, icon_key, is_active)
       VALUES (:type, :channel, :category, :quiet, :maxDelay, :priority, :deepLink, :icon, 1)
       ON DUPLICATE KEY UPDATE channel = VALUES(channel), category = VALUES(category),
         quiet_hours = VALUES(quiet_hours), max_delay_min = VALUES(max_delay_min),
         priority = VALUES(priority), deep_link = VALUES(deep_link), icon_key = VALUES(icon_key),
         is_active = 1`,
      {
        type: t.type,
        channel: t.channel.join(','),
        category: t.category,
        quiet: t.quietHours,
        maxDelay: t.maxDelayMin ?? null,
        priority: t.priority ?? 5,
        deepLink: t.deepLink ?? null,
        icon: t.iconKey ?? null,
      },
      conn,
    );
    await db.run(
      'DELETE FROM notification_template_translations WHERE type = :type',
      { type: t.type },
      conn,
    );
    for (const [locale, tr] of Object.entries(t.translations)) {
      await db.run(
        `INSERT INTO notification_template_translations (type, locale, title, body)
         VALUES (:type, :locale, :title, :body)`,
        { type: t.type, locale, title: tr.title, body: tr.body },
        conn,
      );
    }
  }
  const placeholders = types.map((_, i) => `:t${i}`).join(', ');
  await db.run(
    `UPDATE notification_templates SET is_active = 0 WHERE type NOT IN (${placeholders})`,
    Object.fromEntries(types.map((t, i) => [`t${i}`, t])),
    conn,
  );

  // Bölge adları ({zone} yer tutucusu): katalog etiketi, ad alanı world_zone.
  await db.run("DELETE FROM catalog_labels WHERE namespace = 'world_zone'", {}, conn);
  for (const [locale, zones] of Object.entries(seed.zones)) {
    for (const [code, label] of Object.entries(zones)) {
      await db.run(
        `INSERT INTO catalog_labels (namespace, code, locale, label)
         VALUES ('world_zone', :code, :locale, :label)`,
        { code, locale, label },
        conn,
      );
    }
  }
  return { templates: types.length };
}
