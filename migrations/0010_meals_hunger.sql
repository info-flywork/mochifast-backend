-- 0010_meals_hunger
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Öğün kayıtları ve açlık check-in'leri (docs/backend/03-veri-modeli.md §3.6).
-- Fotoğraf analizi (food_photo_analyses, media) F5/F6'da; bağlantı sütunları şimdiden burada.

CREATE TABLE meals (
  -- İstemci üretebilir (UUIDv7): çevrimdışı kayıt tekrar gönderilince yinelenmez.
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  eaten_at           DATETIME(3)  NOT NULL,
  local_date         DATE         NOT NULL,
  tz                 VARCHAR(64)  NOT NULL,
  kind               ENUM('meal', 'snack') NULL,
  slot               ENUM('breakfast', 'lunch', 'dinner', 'snack') NULL,
  diet_type          ENUM('ketogenic', 'low_carb', 'mixed', 'high_carb', 'not_sure') NULL,
  feeling            ENUM('meh', 'good', 'super') NULL,
  title              VARCHAR(120) NULL,
  -- AES-256-GCM (infra/crypto.js), ≤ 1000 karakter.
  notes_enc          VARBINARY(4096) NULL,
  kcal               SMALLINT UNSIGNED NULL,
  protein_g          DECIMAL(6,1) NULL,
  carbs_g            DECIMAL(6,1) NULL,
  fat_g              DECIMAL(6,1) NULL,
  photo_media_id     BINARY(16)   NULL,
  analysis_id        BINARY(16)   NULL,
  source             ENUM('manual', 'ai_photo', 'quick_kcal') NOT NULL DEFAULT 'manual',
  -- Bu öğün bir orucu bitirdiyse (istemci "orucu bitir?" önerisini kabul etti).
  breaks_fast_session_id BINARY(16) NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_meals_user_date (user_id, local_date, deleted_at),
  KEY ix_meals_user_time (user_id, eaten_at),
  CONSTRAINT fk_meals_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_meals_fast FOREIGN KEY (breaks_fast_session_id)
    REFERENCES fasting_sessions (id) ON DELETE SET NULL,
  CONSTRAINT ck_meals_kcal CHECK (kcal IS NULL OR kcal <= 10000)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Sonuç sunucuda hesaplanır (05 §5); istemcinin gönderdiği sonuç saklanmaz.
CREATE TABLE hunger_checkins (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  logged_at          DATETIME(3)  NOT NULL,
  local_date         DATE         NOT NULL,
  tz                 VARCHAR(64)  NOT NULL,
  mode               ENUM('quick', 'full', 'hungry_now') NOT NULL,
  symptoms           SET('sleeplessness', 'headache', 'dizziness', 'nausea', 'fatigue', 'weakness')
                     NOT NULL DEFAULT '',
  q1_simple_food     ENUM('yes', 'not_really', 'not_sure') NULL,
  q2_onset           ENUM('gradually', 'suddenly', 'not_sure') NULL,
  q3_body_notices    SET('stomach_growling', 'low_energy', 'dizziness', 'nausea', 'fatigue',
                         'nothing_physical') NOT NULL DEFAULT '',
  q4_craving         ENUM('almost_anything', 'something_sweet', 'fast_food', 'not_sure') NULL,
  physical_score     TINYINT UNSIGNED NOT NULL,
  emotional_score    TINYINT UNSIGNED NOT NULL,
  result_type        ENUM('physical', 'emotional') NOT NULL,
  safety_flag        TINYINT(1)   NOT NULL DEFAULT 0,
  -- Puan tablosu değişirse eski kayıtlar kendi sürümüyle kalır.
  scoring_version    TINYINT UNSIGNED NOT NULL DEFAULT 1,
  notes_enc          VARBINARY(4096) NULL,
  -- Kayıt anındaki aktif oruç (bağlam puanı ve güvenlik bayrağı bundan hesaplandı).
  fasting_session_id BINARY(16)   NULL,
  fasted_minutes     SMALLINT UNSIGNED NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_hunger_user_date (user_id, local_date, result_type),
  KEY ix_hunger_user_time (user_id, logged_at),
  CONSTRAINT fk_hunger_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_hunger_fast FOREIGN KEY (fasting_session_id)
    REFERENCES fasting_sessions (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
