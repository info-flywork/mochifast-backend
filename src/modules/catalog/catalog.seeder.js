import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { seedGamification } from '../gamification/gamification.seeder.js';
import { seedNotifications } from '../notifications/notifications.seeder.js';
import { seedContent } from './content.seeder.js';

/**
 * Katalog seed'lerini (seeds/*.json) veritabanına yazar. İdempotent: plan koduna göre upsert;
 * seed'den çıkarılan plan silinmez, pasifleşir (kullanıcı planları ona bağlı olabilir).
 * Her çalıştırmada `catalog.version` artar → API'deki katalog cache'i yenilenir.
 *
 * app_config: yalnızca EKSİK anahtarlar eklenir; mevcut değerler (yönetim panelinden
 * değiştirilmiş olabilir) korunur. `overwriteConfig: true` ile seed değerleri yazılır.
 */

const SEEDS_DIR = fileURLToPath(new URL('../../../seeds/', import.meta.url));

export async function loadCatalogSeeds(dir = SEEDS_DIR) {
  const read = async (name) => JSON.parse(await readFile(`${dir}/${name}`, 'utf8'));
  return {
    plans: await read('plans.json'),
    // İçerik etiketleri (onboarding, sohbet önerileri) extract-translations.js ile üretilir.
    labels: { ...(await read('catalog_labels.json')), ...(await read('content_labels.json')) },
    appConfig: await read('app_config.json'),
    content: await read('content.json'),
    gamification: await read('gamification.json'),
    notifications: await read('notifications.json'),
  };
}

export async function seedCatalog(db, seeds, { overwriteConfig = false } = {}) {
  return db.withTransaction(async (conn) => {
    const stats = { plans: 0, deactivated: 0, labels: 0, configAdded: 0 };
    if (seeds.content) stats.content = await seedContent(db, conn, seeds.content);
    if (seeds.gamification) {
      stats.gamification = await seedGamification(db, conn, seeds.gamification);
    }
    if (seeds.notifications) {
      stats.notifications = await seedNotifications(db, conn, seeds.notifications);
    }

    for (const p of seeds.plans) {
      await db.run(
        `INSERT INTO fasting_plans
           (code, category, schedule_type, fast_hours, eat_hours, reduced_days_per_week,
            reduced_day_kcal, intensity, is_premium, is_featured, min_age, requires_safety_ack,
            default_timing, default_eat_start, allowed_timings, sort_order, is_active)
         VALUES (:code, :category, :scheduleType, :fastHours, :eatHours, :reducedDaysPerWeek,
                 :reducedDayKcal, :intensity, :isPremium, :isFeatured, :minAge, :requiresSafetyAck,
                 :defaultTiming, :defaultEatStart, :allowedTimings, :sortOrder, 1)
         ON DUPLICATE KEY UPDATE
           category = VALUES(category), schedule_type = VALUES(schedule_type),
           fast_hours = VALUES(fast_hours), eat_hours = VALUES(eat_hours),
           reduced_days_per_week = VALUES(reduced_days_per_week),
           reduced_day_kcal = VALUES(reduced_day_kcal), intensity = VALUES(intensity),
           is_premium = VALUES(is_premium), is_featured = VALUES(is_featured),
           min_age = VALUES(min_age), requires_safety_ack = VALUES(requires_safety_ack),
           default_timing = VALUES(default_timing), default_eat_start = VALUES(default_eat_start),
           allowed_timings = VALUES(allowed_timings), sort_order = VALUES(sort_order),
           is_active = 1`,
        {
          code: p.code,
          category: p.category,
          scheduleType: p.scheduleType,
          fastHours: p.fastHours ?? null,
          eatHours: p.eatHours ?? null,
          reducedDaysPerWeek: p.reducedDaysPerWeek ?? null,
          reducedDayKcal: p.reducedDayKcal ?? null,
          intensity: p.intensity,
          isPremium: p.isPremium ? 1 : 0,
          isFeatured: p.isFeatured ? 1 : 0,
          minAge: p.minAge,
          requiresSafetyAck: p.requiresSafetyAck ? 1 : 0,
          defaultTiming: p.defaultTiming ?? null,
          defaultEatStart: p.defaultEatStart ?? null,
          allowedTimings: (p.allowedTimings ?? []).join(','),
          sortOrder: p.sortOrder,
        },
        conn,
      );
      const { id } = await db.one('SELECT id FROM fasting_plans WHERE code = :code', p, conn);

      await db.run('DELETE FROM fasting_plan_translations WHERE plan_id = :id', { id }, conn);
      for (const [locale, tr] of Object.entries(p.translations)) {
        await db.run(
          `INSERT INTO fasting_plan_translations
             (plan_id, locale, display_name, card_label, short_description, long_description, safety_note)
           VALUES (:id, :locale, :displayName, :cardLabel, :shortDescription, :longDescription, :safetyNote)`,
          {
            id,
            locale,
            displayName: tr.displayName,
            cardLabel: tr.cardLabel,
            shortDescription: tr.shortDescription,
            longDescription: tr.longDescription ?? null,
            safetyNote: tr.safetyNote ?? null,
          },
          conn,
        );
      }

      await db.run('DELETE FROM fasting_plan_groups WHERE plan_id = :id', { id }, conn);
      for (const category of p.groups ?? [p.category]) {
        await db.run(
          'INSERT INTO fasting_plan_groups (category, plan_id, sort_order) VALUES (:category, :id, :sortOrder)',
          { category, id, sortOrder: p.sortOrder },
          conn,
        );
      }
      stats.plans += 1;
    }

    const wanted = new Set(seeds.plans.map((p) => p.code));
    for (const { code } of await db.many(
      'SELECT code FROM fasting_plans WHERE is_active = 1',
      {},
      conn,
    )) {
      if (!wanted.has(code)) {
        await db.run('UPDATE fasting_plans SET is_active = 0 WHERE code = :code', { code }, conn);
        stats.deactivated += 1;
      }
    }

    for (const [namespace, entries] of Object.entries(seeds.labels)) {
      await db.run('DELETE FROM catalog_labels WHERE namespace = :namespace', { namespace }, conn);
      for (const [code, byLocale] of Object.entries(entries)) {
        for (const [locale, label] of Object.entries(byLocale)) {
          await db.run(
            `INSERT INTO catalog_labels (namespace, code, locale, label)
             VALUES (:namespace, :code, :locale, :label)`,
            { namespace, code, locale, label },
            conn,
          );
          stats.labels += 1;
        }
      }
    }

    const existing = new Set(
      (await db.many('SELECT config_key, platform FROM app_config', {}, conn)).map(
        (r) => `${r.config_key}|${r.platform}`,
      ),
    );
    for (const row of seeds.appConfig) {
      if (row.key === 'catalog.version') continue;
      if (!existing.has(`${row.key}|${row.platform}`)) stats.configAdded += 1;
      await db.run(
        overwriteConfig
          ? `INSERT INTO app_config (config_key, platform, value, description)
             VALUES (:key, :platform, :value, :description)
             ON DUPLICATE KEY UPDATE value = VALUES(value), description = VALUES(description)`
          : `INSERT INTO app_config (config_key, platform, value, description)
             VALUES (:key, :platform, :value, :description)
             ON DUPLICATE KEY UPDATE description = VALUES(description)`,
        { ...row, value: JSON.stringify(row.value), description: row.description ?? null },
        conn,
      );
    }

    const current = await db.one(
      `SELECT CAST(value AS CHAR) AS value FROM app_config
        WHERE config_key = 'catalog.version' AND platform = 'all'`,
      {},
      conn,
    );
    const version = (current ? Number(JSON.parse(current.value)) || 0 : 0) + 1;
    await db.run(
      `INSERT INTO app_config (config_key, platform, value, description)
       VALUES ('catalog.version', 'all', :value, 'Katalog cache sürümü; npm run seed artırır')
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      { value: JSON.stringify(version) },
      conn,
    );
    stats.catalogVersion = version;
    return stats;
  });
}
