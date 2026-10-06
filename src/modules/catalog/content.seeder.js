/**
 * İçerik seed'i (seeds/content.json): evreler, zorlanma, Insights, SSS, sıralı listeler.
 * seedCatalog'un transaction'ı içinde çalışır. Ana kayıtlar doğal anahtarlarıyla upsert edilir
 * (ileride kullanıcı verisi bağlanabilir); çeviriler ve bölümler yeniden yazılır; seed'den
 * çıkarılan kayıtlar silinir (Insights makalesi arşivlenir).
 */
export async function seedContent(db, conn, content) {
  const run = (sql, params) => db.run(sql, params, conn);
  const stats = { stages: 0, struggle: 0, insightArticles: 0, faq: 0, items: 0 };

  // ── Evreler
  const stageKeys = new Set();
  for (const s of content.stages) {
    await run(
      `INSERT INTO fasting_stages (stage_type, position, start_hour, end_hour, image_key, image_idle, image_reached)
       VALUES (:type, :position, :startHour, :endHour, :imageKey, :imageIdle, :imageReached)
       ON DUPLICATE KEY UPDATE start_hour = VALUES(start_hour), end_hour = VALUES(end_hour),
         image_key = VALUES(image_key), image_idle = VALUES(image_idle),
         image_reached = VALUES(image_reached)`,
      { ...s, startHour: s.startHour, endHour: s.endHour },
    );
    const { id } = await db.one(
      'SELECT id FROM fasting_stages WHERE stage_type = :type AND position = :position',
      s,
      conn,
    );
    stageKeys.add(id);
    await run('DELETE FROM fasting_stage_translations WHERE stage_id = :id', { id });
    for (const [locale, tr] of Object.entries(s.translations)) {
      await run(
        `INSERT INTO fasting_stage_translations (stage_id, locale, range_label, title, body)
         VALUES (:id, :locale, :rangeLabel, :title, :body)`,
        { id, locale, rangeLabel: tr.rangeLabel ?? null, title: tr.title, body: tr.body },
      );
    }
    stats.stages += 1;
  }
  for (const { id } of await db.many('SELECT id FROM fasting_stages', {}, conn)) {
    if (!stageKeys.has(id)) await run('DELETE FROM fasting_stages WHERE id = :id', { id });
  }

  // ── Zorlanma
  await run('DELETE FROM struggle_translations', {});
  const translate = async (entityType, code, translations) => {
    for (const [locale, tr] of Object.entries(translations)) {
      await run(
        `INSERT INTO struggle_translations
           (entity_type, code, locale, title, body, session_title, session_body,
            done_title, done_body, done_button)
         VALUES (:entityType, :code, :locale, :title, :body, :sessionTitle, :sessionBody,
                 :doneTitle, :doneBody, :doneButton)`,
        {
          entityType,
          code,
          locale,
          title: tr.title,
          body: tr.body,
          sessionTitle: tr.sessionTitle ?? null,
          sessionBody: tr.sessionBody ?? null,
          doneTitle: tr.doneTitle ?? null,
          doneBody: tr.doneBody ?? null,
          doneButton: tr.doneButton ?? null,
        },
      );
    }
  };
  await translate('intro', 'intro', content.struggle.intro);
  await run('DELETE FROM struggle_reasons', {});
  await run('DELETE FROM struggle_tips', {});
  for (const r of content.struggle.reasons) {
    await run(
      `INSERT INTO struggle_reasons (code, image, tips, sort_order)
       VALUES (:code, :image, :tips, :sortOrder)`,
      { ...r, tips: JSON.stringify(r.tips) },
    );
    await translate('reason', r.code, r.translations);
    stats.struggle += 1;
  }
  for (const tip of content.struggle.tips) {
    await run(
      `INSERT INTO struggle_tips (code, image, activity_params, sort_order)
       VALUES (:code, :image, :activity, :sortOrder)`,
      { ...tip, activity: JSON.stringify(tip.activity) },
    );
    await translate('tip', tip.code, tip.translations);
  }

  // ── Insights
  const categoryIds = {};
  for (const c of content.insights.categories) {
    await run(
      `INSERT INTO insight_categories (slug, icon_key, icon_image, bg_color, is_premium, sort_order, is_active)
       VALUES (:slug, :icon, :iconImage, :bgColor, :isPremium, :sortOrder, 1)
       ON DUPLICATE KEY UPDATE icon_key = VALUES(icon_key), icon_image = VALUES(icon_image),
         bg_color = VALUES(bg_color), is_premium = VALUES(is_premium),
         sort_order = VALUES(sort_order), is_active = 1`,
      { ...c, isPremium: c.isPremium ? 1 : 0 },
    );
    const { id } = await db.one('SELECT id FROM insight_categories WHERE slug = :slug', c, conn);
    categoryIds[c.slug] = id;
    await run('DELETE FROM insight_category_translations WHERE category_id = :id', { id });
    for (const [locale, tr] of Object.entries(c.translations)) {
      await run(
        `INSERT INTO insight_category_translations (category_id, locale, title, description)
         VALUES (:id, :locale, :title, :description)`,
        { id, locale, ...tr },
      );
    }
  }
  const slugs = new Set(content.insights.categories.map((c) => c.slug));
  await run('UPDATE insight_categories SET is_active = 0 WHERE NOT FIND_IN_SET(slug, :slugs)', {
    slugs: [...slugs].join(','),
  });

  const articleSlugs = [];
  for (const a of content.insights.articles) {
    await run(
      `INSERT INTO insight_articles
         (category_id, slug, is_premium, status, read_minutes, published_at, sort_order)
       VALUES (:categoryId, :slug, :isPremium, 'published', :readMinutes, NOW(3), :sortOrder)
       ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), is_premium = VALUES(is_premium),
         status = 'published', read_minutes = VALUES(read_minutes),
         published_at = COALESCE(published_at, VALUES(published_at)), sort_order = VALUES(sort_order)`,
      { ...a, categoryId: categoryIds[a.category], isPremium: a.isPremium ? 1 : 0 },
    );
    const { id } = await db.one('SELECT id FROM insight_articles WHERE slug = :slug', a, conn);
    articleSlugs.push(a.slug);
    await run('DELETE FROM insight_article_translations WHERE article_id = :id', { id });
    await run('DELETE FROM insight_sections WHERE article_id = :id', { id });
    const sectionIds = [];
    for (const s of a.sections) {
      await run(
        `INSERT INTO insight_sections (article_id, position, icon_key, icon_image)
         VALUES (:id, :position, :icon, :iconImage)`,
        { id, ...s },
      );
      const row = await db.one(
        'SELECT id FROM insight_sections WHERE article_id = :id AND position = :position',
        { id, position: s.position },
        conn,
      );
      sectionIds.push(row.id);
      for (const [locale, tr] of Object.entries(s.translations)) {
        await run(
          `INSERT INTO insight_section_translations (section_id, locale, title, body)
           VALUES (:sectionId, :locale, :title, :body)`,
          { sectionId: row.id, locale, ...tr },
        );
      }
    }
    for (const [locale, tr] of Object.entries(a.translations)) {
      // Arama metni: başlık, alt başlık, alıntı, ipucu ve bölümler; küçük harf.
      const parts = [tr.title, tr.subtitle, tr.quote, tr.tip, tr.kicker];
      for (const s of a.sections) {
        const st = s.translations[locale] ?? s.translations.en;
        parts.push(st.title, st.body);
      }
      await run(
        `INSERT INTO insight_article_translations
           (article_id, locale, kicker, title, subtitle, quote, quote_author, tip, search_text)
         VALUES (:id, :locale, :kicker, :title, :subtitle, :quote, :quoteAuthor, :tip, :searchText)`,
        {
          id,
          locale,
          kicker: tr.kicker,
          title: tr.title,
          subtitle: tr.subtitle ?? null,
          quote: tr.quote ?? null,
          quoteAuthor: tr.quoteAuthor ?? null,
          tip: tr.tip ?? null,
          searchText: parts.filter(Boolean).join('\n').toLocaleLowerCase(locale),
        },
      );
    }
    stats.insightArticles += 1;
  }
  await run("UPDATE insight_articles SET status = 'archived' WHERE NOT FIND_IN_SET(slug, :slugs)", {
    slugs: articleSlugs.join(','),
  });

  // ── SSS
  for (const f of content.faq) {
    await run(
      `INSERT INTO faq_items (code, sort_order, is_active) VALUES (:code, :sortOrder, 1)
       ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), is_active = 1`,
      f,
    );
    const { id } = await db.one('SELECT id FROM faq_items WHERE code = :code', f, conn);
    await run('DELETE FROM faq_item_translations WHERE faq_id = :id', { id });
    for (const [locale, tr] of Object.entries(f.translations)) {
      await run(
        `INSERT INTO faq_item_translations (faq_id, locale, question, answer)
         VALUES (:id, :locale, :question, :answer)`,
        { id, locale, ...tr },
      );
    }
    stats.faq += 1;
  }
  await run('UPDATE faq_items SET is_active = 0 WHERE NOT FIND_IN_SET(code, :codes)', {
    codes: content.faq.map((f) => f.code).join(','),
  });

  // ── Sıralı listeler
  for (const [namespace, entries] of Object.entries(content.items)) {
    await run('DELETE FROM catalog_items WHERE namespace = :namespace', { namespace });
    for (const e of entries) {
      await run(
        `INSERT INTO catalog_items (namespace, code, sort_order, data)
         VALUES (:namespace, :code, :sortOrder, :data)`,
        { namespace, ...e, data: e.data ? JSON.stringify(e.data) : null },
      );
      stats.items += 1;
    }
  }
  return stats;
}
