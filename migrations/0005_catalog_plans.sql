-- 0005_catalog_plans
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Plan kataloğu (docs/backend/03-veri-modeli.md §3.3) + uygulama yapılandırması (§3.5 app_config).
-- İçerik seed'lerden gelir: npm run seed (idempotent, koda göre upsert).

CREATE TABLE fasting_plans (
  id                    SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code                  VARCHAR(32)  NOT NULL,
  -- Birincil kategori (güvenlik/premium kuralları). Gösterim grupları: fasting_plan_groups.
  category              ENUM('beginner', 'popular', 'intermediate', 'advanced', 'weekly', 'flexible') NOT NULL,
  schedule_type         ENUM('daily', 'weekly_reduced', 'alternate_day', 'selected_days', 'custom_daily', 'custom_weekly') NOT NULL,
  -- Günlük planlarda süre; özel planlarda başlangıç önerisi.
  fast_hours            DECIMAL(4,1) NULL,
  eat_hours             DECIMAL(4,1) NULL,
  reduced_days_per_week TINYINT UNSIGNED NULL,
  reduced_day_kcal      SMALLINT UNSIGNED NULL,
  intensity             TINYINT UNSIGNED NOT NULL,
  is_premium            TINYINT(1)   NOT NULL DEFAULT 0,
  is_featured           TINYINT(1)   NOT NULL DEFAULT 0,
  min_age               TINYINT UNSIGNED NOT NULL DEFAULT 18,
  requires_safety_ack   TINYINT(1)   NOT NULL DEFAULT 0,
  default_timing        ENUM('skip_breakfast', 'skip_dinner', 'early_window', 'late_window', 'custom') NULL,
  default_eat_start     TIME         NULL,
  allowed_timings       SET('skip_breakfast', 'skip_dinner', 'early_window', 'late_window', 'custom') NOT NULL DEFAULT '',
  sort_order            SMALLINT     NOT NULL DEFAULT 0,
  is_active             TINYINT(1)   NOT NULL DEFAULT 1,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_plans_code (code),
  KEY ix_plans_category (category, sort_order)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE fasting_plan_translations (
  plan_id               SMALLINT UNSIGNED NOT NULL,
  locale                VARCHAR(10)  NOT NULL,
  display_name          VARCHAR(40)  NOT NULL,
  card_label            VARCHAR(40)  NOT NULL,
  short_description     VARCHAR(160) NOT NULL,
  long_description      TEXT         NULL,
  safety_note           TEXT         NULL,
  PRIMARY KEY (plan_id, locale),
  CONSTRAINT fk_plan_tr_plan FOREIGN KEY (plan_id) REFERENCES fasting_plans (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Plan ekranındaki gruplar; bir plan birden çok grupta görünebilir (ör. 18:6 Popular + Intermediate).
CREATE TABLE fasting_plan_groups (
  category              ENUM('beginner', 'popular', 'intermediate', 'advanced', 'weekly', 'flexible') NOT NULL,
  plan_id               SMALLINT UNSIGNED NOT NULL,
  sort_order            SMALLINT     NOT NULL DEFAULT 0,
  PRIMARY KEY (category, plan_id),
  CONSTRAINT fk_plan_groups_plan FOREIGN KEY (plan_id) REFERENCES fasting_plans (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Küçük, sabit listelerin çevirileri: plan kategorisi başlıkları, zamanlama tercihleri …
CREATE TABLE catalog_labels (
  namespace             VARCHAR(32)  NOT NULL,
  code                  VARCHAR(48)  NOT NULL,
  locale                VARCHAR(10)  NOT NULL,
  label                 VARCHAR(160) NOT NULL,
  PRIMARY KEY (namespace, code, locale)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Ürün parametreleri (min sürüm, limitler, özellikler, pazarlama sayıları, yasal sürümler).
CREATE TABLE app_config (
  config_key            VARCHAR(80)  NOT NULL,
  platform              ENUM('all', 'ios', 'android') NOT NULL DEFAULT 'all',
  value                 JSON         NOT NULL,
  description           VARCHAR(255) NULL,
  updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (config_key, platform)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
