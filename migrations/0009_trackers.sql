-- 0009_trackers
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Su, adım ve uyku takipçileri (docs/backend/03-veri-modeli.md §3.6). weight_entries 0003'te.

CREATE TABLE water_entries (
  -- İstemci üretebilir (UUIDv7): çevrimdışı kayıt tekrar gönderilince yinelenmez.
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  amount_ml          SMALLINT UNSIGNED NOT NULL,
  logged_at          DATETIME(3)  NOT NULL,
  -- Kaydın yerel günü: gece yarısı sıfırlaması bu sütunla kendiliğinden olur (05 §12).
  local_date         DATE         NOT NULL,
  tz                 VARCHAR(64)  NOT NULL,
  source             ENUM('app', 'widget', 'apple_health', 'google_fit') NOT NULL DEFAULT 'app',
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_water_user_date (user_id, local_date, deleted_at),
  CONSTRAINT fk_water_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_water_amount CHECK (amount_ml BETWEEN 1 AND 5000)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Günlük adım; kaynak önceliği: sağlık senkronu > manuel (05 §8).
CREATE TABLE step_daily (
  user_id            BINARY(16)   NOT NULL,
  local_date         DATE         NOT NULL,
  steps              MEDIUMINT UNSIGNED NOT NULL,
  distance_m         MEDIUMINT UNSIGNED NULL,
  active_kcal        SMALLINT UNSIGNED NULL,
  source             ENUM('manual', 'apple_health', 'google_fit') NOT NULL,
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, local_date),
  CONSTRAINT fk_steps_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE sleep_entries (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  sleep_start        DATETIME(3)  NOT NULL,
  sleep_end          DATETIME(3)  NOT NULL,
  duration_minutes   SMALLINT UNSIGNED NOT NULL,
  -- Uyanış günü.
  local_date         DATE         NOT NULL,
  tz                 VARCHAR(64)  NOT NULL,
  quality            TINYINT UNSIGNED NULL,
  source             ENUM('manual', 'apple_health', 'google_fit') NOT NULL DEFAULT 'manual',
  -- Sağlık uygulamasındaki örneğin kimliği: senkron tekrarlanınca aynı kayıt güncellenir.
  external_id        VARCHAR(128) NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_sleep_user_date (user_id, local_date),
  UNIQUE KEY uq_sleep_external (user_id, source, external_id),
  CONSTRAINT fk_sleep_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_sleep_order CHECK (sleep_end > sleep_start),
  CONSTRAINT ck_sleep_quality CHECK (quality IS NULL OR quality BETWEEN 1 AND 5)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Grafik ve günlük özet için kilo kayıtları yerel güne göre de okunur.
ALTER TABLE weight_entries ADD KEY ix_weight_user_date (user_id, local_date);
