import { DEFAULT_LOCALE } from '../../config/constants.js';

/**
 * İçerik SQL'i. Her sorgu istenen dili, yoksa varsayılan dili (en) döner. Sonuçlar servis
 * katmanında dil başına önbelleklenir; bu sorgular yalnızca önbellek dolarken çalışır.
 */
const params = (locale, extra = {}) => ({ locale, fallback: DEFAULT_LOCALE, ...extra });

export function loadStages(db, type, locale) {
  return db.many(
    `SELECT s.position, s.start_hour, s.end_hour, s.image_key, s.image_idle, s.image_reached,
            COALESCE(t.range_label, d.range_label) AS range_label,
            COALESCE(t.title, d.title) AS title,
            COALESCE(t.body, d.body) AS body
       FROM fasting_stages s
       LEFT JOIN fasting_stage_translations t ON t.stage_id = s.id AND t.locale = :locale
       LEFT JOIN fasting_stage_translations d ON d.stage_id = s.id AND d.locale = :fallback
      WHERE s.stage_type = :type
      ORDER BY s.position`,
    params(locale, { type }),
  );
}

export async function loadStruggle(db, locale) {
  const [reasons, tips, texts] = await Promise.all([
    db.many(
      'SELECT code, image, CAST(tips AS CHAR) AS tips FROM struggle_reasons ORDER BY sort_order',
    ),
    db.many(
      'SELECT code, image, CAST(activity_params AS CHAR) AS activity FROM struggle_tips ORDER BY sort_order',
    ),
    db.many(
      `SELECT entity_type, code, locale, title, body, session_title, session_body,
              done_title, done_body, done_button
         FROM struggle_translations WHERE locale IN (:locale, :fallback)`,
      params(locale),
    ),
  ]);
  return { reasons, tips, texts };
}

export function loadFaq(db, locale) {
  return db.many(
    `SELECT f.code, COALESCE(t.question, d.question) AS question,
            COALESCE(t.answer, d.answer) AS answer
       FROM faq_items f
       LEFT JOIN faq_item_translations t ON t.faq_id = f.id AND t.locale = :locale
       LEFT JOIN faq_item_translations d ON d.faq_id = f.id AND d.locale = :fallback
      WHERE f.is_active = 1
      ORDER BY f.sort_order`,
    params(locale),
  );
}

export function loadItems(db, namespace) {
  return db.many(
    `SELECT code, CAST(data AS CHAR) AS data FROM catalog_items
      WHERE namespace = :namespace ORDER BY sort_order`,
    { namespace },
  );
}

export async function loadInsights(db, locale) {
  const [categories, articles, sections] = await Promise.all([
    db.many(
      `SELECT c.id, c.slug, c.icon_key, c.icon_image, c.bg_color, c.is_premium,
              COALESCE(t.title, d.title) AS title,
              COALESCE(t.description, d.description) AS description
         FROM insight_categories c
         LEFT JOIN insight_category_translations t ON t.category_id = c.id AND t.locale = :locale
         LEFT JOIN insight_category_translations d ON d.category_id = c.id AND d.locale = :fallback
        WHERE c.is_active = 1
        ORDER BY c.sort_order`,
      params(locale),
    ),
    db.many(
      `SELECT a.id, a.category_id, a.slug, a.is_premium, a.read_minutes, a.published_at,
              a.sort_order,
              COALESCE(t.kicker, d.kicker) AS kicker,
              COALESCE(t.title, d.title) AS title,
              COALESCE(t.subtitle, d.subtitle) AS subtitle,
              COALESCE(t.quote, d.quote) AS quote,
              COALESCE(t.quote_author, d.quote_author) AS quote_author,
              COALESCE(t.tip, d.tip) AS tip,
              COALESCE(t.search_text, d.search_text) AS search_text
         FROM insight_articles a
         LEFT JOIN insight_article_translations t ON t.article_id = a.id AND t.locale = :locale
         LEFT JOIN insight_article_translations d ON d.article_id = a.id AND d.locale = :fallback
        WHERE a.status = 'published'
        ORDER BY a.sort_order, a.slug`,
      params(locale),
    ),
    db.many(
      `SELECT s.article_id, s.position, s.icon_key, s.icon_image,
              COALESCE(t.title, d.title) AS title,
              COALESCE(t.body, d.body) AS body
         FROM insight_sections s
         LEFT JOIN insight_section_translations t ON t.section_id = s.id AND t.locale = :locale
         LEFT JOIN insight_section_translations d ON d.section_id = s.id AND d.locale = :fallback
        ORDER BY s.article_id, s.position`,
      params(locale),
    ),
  ]);
  return { categories, articles, sections };
}
