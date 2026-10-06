-- 0006_content
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- İçerik katalogları (docs/backend/03-veri-modeli.md §3.5). İçerik seed'den gelir:
-- scripts/extract-translations.js (uygulama çevirilerinden) → seeds/content*.json → npm run seed.
-- Görseller uygulamadaki mantıksal yollardır (assets/images/…png → CDN/gömülü, appImage()).

-- Vücut evreleri (9) ve yeme penceresi evreleri (3)
CREATE TABLE fasting_stages (
  id                 SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stage_type         ENUM('body', 'eating_window') NOT NULL,
  position           TINYINT UNSIGNED NOT NULL,
  start_hour         DECIMAL(5,2) NULL,
  end_hour           DECIMAL(5,2) NULL,
  image_key          VARCHAR(40)  NOT NULL,
  -- idle: henüz ulaşılmadı / pasif; reached: ulaşıldı / aktif.
  image_idle         VARCHAR(160) NULL,
  image_reached      VARCHAR(160) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stages (stage_type, position)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE fasting_stage_translations (
  stage_id           SMALLINT UNSIGNED NOT NULL,
  locale             VARCHAR(10)  NOT NULL,
  range_label        VARCHAR(20)  NULL,
  title              VARCHAR(80)  NOT NULL,
  -- Paragraflar "\n\n", vurgu **…** (istemci biçimlendirir).
  body               TEXT         NOT NULL,
  PRIMARY KEY (stage_id, locale),
  CONSTRAINT fk_stage_tr FOREIGN KEY (stage_id) REFERENCES fasting_stages (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Zorlanma (struggle) içeriği: sebep → önerilen ipuçları (sıralı)
CREATE TABLE struggle_reasons (
  code               VARCHAR(20)  NOT NULL,
  image              VARCHAR(160) NOT NULL,
  tips               JSON         NOT NULL,
  sort_order         TINYINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (code)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE struggle_tips (
  code               VARCHAR(20)  NOT NULL,
  image              VARCHAR(160) NOT NULL,
  -- {"type":"sips","sips":8} | {"type":"timer","seconds":180} | {"type":"breathing","inhale":4,…}
  activity_params    JSON         NOT NULL,
  sort_order         TINYINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (code)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE struggle_translations (
  entity_type        ENUM('intro', 'reason', 'tip') NOT NULL,
  code               VARCHAR(20)  NOT NULL,
  locale             VARCHAR(10)  NOT NULL,
  title              VARCHAR(80)  NOT NULL,
  body               TEXT         NOT NULL,
  session_title      VARCHAR(80)  NULL,
  session_body       TEXT         NULL,
  done_title         VARCHAR(80)  NULL,
  done_body          TEXT         NULL,
  done_button        VARCHAR(60)  NULL,
  PRIMARY KEY (entity_type, code, locale)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Insights / Learn
CREATE TABLE insight_categories (
  id                 SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug               VARCHAR(40)  NOT NULL,
  icon_key           VARCHAR(30)  NOT NULL,
  icon_image         VARCHAR(160) NULL,
  -- '#FDEBE1' ya da alfa ile '#96BD8F33'
  bg_color           CHAR(9)      NOT NULL,
  is_premium         TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order         SMALLINT     NOT NULL DEFAULT 0,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_insight_cat_slug (slug)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE insight_category_translations (
  category_id        SMALLINT UNSIGNED NOT NULL,
  locale             VARCHAR(10)  NOT NULL,
  title              VARCHAR(80)  NOT NULL,
  description        VARCHAR(200) NOT NULL,
  PRIMARY KEY (category_id, locale),
  CONSTRAINT fk_insight_cat_tr FOREIGN KEY (category_id) REFERENCES insight_categories (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE insight_articles (
  id                 SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id        SMALLINT UNSIGNED NOT NULL,
  slug               VARCHAR(80)  NOT NULL,
  is_premium         TINYINT(1)   NOT NULL DEFAULT 0,
  status             ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'draft',
  read_minutes       TINYINT UNSIGNED NULL,
  published_at       DATETIME(3)  NULL,
  sort_order         SMALLINT     NOT NULL DEFAULT 0,
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_insight_article_slug (slug),
  KEY ix_insight_article_cat (category_id, status, sort_order),
  CONSTRAINT fk_insight_article_cat FOREIGN KEY (category_id) REFERENCES insight_categories (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Arama: search_text (başlık + bölümler, küçük harf düz metin) üzerinde LIKE. İçerik az;
-- MariaDB'de ngram FULLTEXT ayrıştırıcısı yok. Makale sayısı yüzleri aşarsa FULLTEXT'e geçilir.
CREATE TABLE insight_article_translations (
  article_id         SMALLINT UNSIGNED NOT NULL,
  locale             VARCHAR(10)  NOT NULL,
  kicker             VARCHAR(60)  NOT NULL,
  title              VARCHAR(160) NOT NULL,
  subtitle           VARCHAR(300) NULL,
  quote              VARCHAR(400) NULL,
  quote_author       VARCHAR(60)  NULL,
  tip                TEXT         NULL,
  search_text        TEXT         NOT NULL,
  PRIMARY KEY (article_id, locale),
  CONSTRAINT fk_insight_article_tr FOREIGN KEY (article_id) REFERENCES insight_articles (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE insight_sections (
  id                 SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  article_id         SMALLINT UNSIGNED NOT NULL,
  position           TINYINT UNSIGNED NOT NULL,
  icon_key           VARCHAR(30)  NOT NULL,
  icon_image         VARCHAR(160) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_insight_section_pos (article_id, position),
  CONSTRAINT fk_insight_section_article FOREIGN KEY (article_id) REFERENCES insight_articles (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE insight_section_translations (
  section_id         SMALLINT UNSIGNED NOT NULL,
  locale             VARCHAR(10)  NOT NULL,
  title              VARCHAR(160) NOT NULL,
  body               TEXT         NOT NULL,
  PRIMARY KEY (section_id, locale),
  CONSTRAINT fk_insight_section_tr FOREIGN KEY (section_id) REFERENCES insight_sections (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- SSS
CREATE TABLE faq_items (
  id                 SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code               VARCHAR(40)  NOT NULL,
  sort_order         SMALLINT     NOT NULL DEFAULT 0,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_faq_code (code)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE faq_item_translations (
  faq_id             SMALLINT UNSIGNED NOT NULL,
  locale             VARCHAR(10)  NOT NULL,
  question           VARCHAR(300) NOT NULL,
  answer             TEXT         NOT NULL,
  PRIMARY KEY (faq_id, locale),
  CONSTRAINT fk_faq_tr FOREIGN KEY (faq_id) REFERENCES faq_items (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Küçük sıralı listeler (onboarding seçenekleri, sohbet önerileri …). Metinleri catalog_labels'ta
-- (namespace + kod [+ ".alan"]); burada sıra ve dil bağımsız veri (görsel, gün sayısı, renk).
CREATE TABLE catalog_items (
  namespace          VARCHAR(32)  NOT NULL,
  code               VARCHAR(48)  NOT NULL,
  sort_order         SMALLINT     NOT NULL DEFAULT 0,
  data               JSON         NULL,
  PRIMARY KEY (namespace, code),
  KEY ix_catalog_items_order (namespace, sort_order)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
