import { DEFAULT_LOCALE } from '../../config/constants.js';

/**
 * Katalog SQL'i. Çeviriler istenen dilde, yoksa varsayılan dilde (en) döner.
 */

export async function loadPlans(db, locale) {
  return db.many(
    `SELECT p.code, p.category, p.schedule_type, p.fast_hours, p.eat_hours,
            p.reduced_days_per_week, p.reduced_day_kcal, p.intensity, p.is_premium,
            p.is_featured, p.min_age, p.requires_safety_ack, p.default_timing,
            p.default_eat_start, p.allowed_timings, p.sort_order,
            COALESCE(t.display_name, d.display_name) AS display_name,
            COALESCE(t.card_label, d.card_label) AS card_label,
            COALESCE(t.short_description, d.short_description) AS short_description,
            COALESCE(t.long_description, d.long_description) AS long_description,
            COALESCE(t.safety_note, d.safety_note) AS safety_note,
            (SELECT GROUP_CONCAT(g.category ORDER BY g.category) FROM fasting_plan_groups g
              WHERE g.plan_id = p.id) AS groups_csv
       FROM fasting_plans p
       LEFT JOIN fasting_plan_translations t ON t.plan_id = p.id AND t.locale = :locale
       LEFT JOIN fasting_plan_translations d ON d.plan_id = p.id AND d.locale = :fallback
      WHERE p.is_active = 1
      ORDER BY p.sort_order, p.code`,
    { locale, fallback: DEFAULT_LOCALE },
  );
}

/** `{ code: label }` — istenen dil, yoksa en. */
export async function loadLabels(db, namespace, locale) {
  const rows = await db.many(
    `SELECT code, locale, label FROM catalog_labels
      WHERE namespace = :namespace AND locale IN (:locale, :fallback)`,
    { namespace, locale, fallback: DEFAULT_LOCALE },
  );
  const out = {};
  for (const r of rows) if (r.locale === DEFAULT_LOCALE) out[r.code] = r.label;
  for (const r of rows) if (r.locale === locale) out[r.code] = r.label;
  return out;
}

/**
 * JSON değer METİN olarak okunur: MySQL JSON kolonu ayrıştırılmış, MariaDB (LONGTEXT) ham metin
 * döndürür; CAST ile ikisi de aynı biçime gelir ve tek yerde JSON.parse edilir.
 */
export async function loadAppConfig(db) {
  return db.many('SELECT config_key, platform, CAST(value AS CHAR) AS value FROM app_config');
}
