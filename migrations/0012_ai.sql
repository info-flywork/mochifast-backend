-- 0012_ai
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Fotoğraftan öğün analizi, AI kotası ve kullanım/maliyet kaydı
-- (docs/backend/03-veri-modeli.md §3.6, §3.8; 09-yapay-zeka.md). Sohbet tabloları ayrı migration'da.

CREATE TABLE food_photo_analyses (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  media_id           BINARY(16)   NOT NULL,
  status             ENUM('queued', 'processing', 'succeeded', 'not_food', 'failed')
                     NOT NULL DEFAULT 'queued',
  locale             VARCHAR(10)  NOT NULL,
  -- Kotanın düşüldüğü yerel gün: başarısızlıkta aynı güne iade edilir.
  quota_date         DATE         NOT NULL,
  model              VARCHAR(64)  NULL,
  prompt_version     VARCHAR(40)  NULL,
  -- {mealTitle, items[], kcal, proteinG, carbsG, fatG, confidence, notes, flags[]}
  result             JSON         NULL,
  error_code         VARCHAR(40)  NULL,
  input_tokens       INT UNSIGNED NULL,
  output_tokens      INT UNSIGNED NULL,
  latency_ms         INT UNSIGNED NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at       DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_analyses_user (user_id, created_at),
  KEY ix_analyses_media (media_id),
  CONSTRAINT fk_analyses_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_analyses_media FOREIGN KEY (media_id) REFERENCES media (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

ALTER TABLE meals
  ADD KEY ix_meals_analysis (analysis_id),
  ADD CONSTRAINT fk_meals_analysis FOREIGN KEY (analysis_id)
    REFERENCES food_photo_analyses (id) ON DELETE SET NULL;

-- AI kota sayacı: kullanıcının YEREL gününe göre (09 §4). Artırma atomik:
--   INSERT … VALUES (…, 1) ON DUPLICATE KEY UPDATE count = count + 1, sonra okunup limitle
--   karşılaştırılır. 3 günden eski satırlar periyodik işle silinir.
CREATE TABLE ai_quota_daily (
  user_id            BINARY(16)   NOT NULL,
  local_date         DATE         NOT NULL,
  kind               ENUM('chat', 'photo_analysis', 'daily_tip') NOT NULL,
  count              INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, local_date, kind),
  KEY ix_ai_quota_date (local_date),
  CONSTRAINT fk_ai_quota_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Maliyet raporu ve global bütçe sigortası (UTC gün).
CREATE TABLE ai_usage_daily (
  user_id            BINARY(16)   NOT NULL,
  usage_date         DATE         NOT NULL,
  feature            ENUM('chat', 'photo_analysis', 'daily_tip', 'chat_summary') NOT NULL,
  requests           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  input_tokens       INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens      INT UNSIGNED NOT NULL DEFAULT 0,
  cache_read_tokens  INT UNSIGNED NOT NULL DEFAULT 0,
  cache_write_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  cost_micro_usd     INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date, feature),
  KEY ix_ai_usage_date (usage_date),
  CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
