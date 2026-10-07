-- 0008_aggregates
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Türetilmiş günlük özetler ve XP olayları (docs/backend/03-veri-modeli.md §3.7).
-- Hepsi ham tablolardan deterministik olarak yeniden üretilebilir (05 §14).

-- Grafiklerin, hafta şeridinin ve serinin kaynağı. Satır yalnızca etkinlik olan günler için
-- yazılır; boş günün hedefi ve serideki durumu plan geçmişinden hesaplanır. Su, adım, öğün, uyku ve açlık
-- sütunları ilgili fazlarda dolar.
CREATE TABLE daily_summaries (
  user_id              BINARY(16)   NOT NULL,
  local_date           DATE         NOT NULL,
  fasted_minutes       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- O günün plan hedefi (anlık görüntü; haftalık planın normal/azaltılmış gününde NULL).
  fast_goal_minutes    SMALLINT UNSIGNED NULL,
  fasts_completed      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_required_fast_day TINYINT(1)   NOT NULL DEFAULT 1,
  water_ml             MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
  water_goal_ml        SMALLINT UNSIGNED NULL,
  steps                MEDIUMINT UNSIGNED NOT NULL DEFAULT 0,
  steps_goal           MEDIUMINT UNSIGNED NULL,
  kcal                 SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  kcal_goal            SMALLINT UNSIGNED NULL,
  protein_g            DECIMAL(6,1) NOT NULL DEFAULT 0,
  protein_goal_g       SMALLINT UNSIGNED NULL,
  carbs_g              DECIMAL(6,1) NOT NULL DEFAULT 0,
  fat_g                DECIMAL(6,1) NOT NULL DEFAULT 0,
  meals_count          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  snacks_count         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sleep_minutes        SMALLINT UNSIGNED NULL,
  sleep_goal_min       SMALLINT UNSIGNED NULL,
  -- Günün son ölçümü.
  weight_kg            DECIMAL(5,2) NULL,
  hunger_physical      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  hunger_emotional     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  xp_earned            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, local_date),
  CONSTRAINT fk_daily_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- XP kaynağı (05 §10). Aynı olay iki kez puan vermez: anahtar (kullanıcı, neden, referans).
-- ref_key: oruçta seans id'si (hex); seri kilometre taşında "<gün>:<serinin ilk günü>".
-- Doküman taslağındaki NULL'a izin veren ref_id yerine: NULL değerler UNIQUE'i delerdi.
CREATE TABLE xp_events (
  user_id              BINARY(16)   NOT NULL,
  reason               ENUM('fast_completed', 'fast_goal_bonus', 'meal_logged', 'water_goal',
                            'weight_logged', 'hunger_checkin', 'challenge_completed',
                            'streak_milestone') NOT NULL,
  ref_key              VARCHAR(64)  NOT NULL,
  amount               SMALLINT     NOT NULL,
  local_date           DATE         NOT NULL,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, reason, ref_key),
  KEY ix_xp_user_date (user_id, local_date),
  CONSTRAINT fk_xp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Gece doğrulaması son 26 saatte değişen seansları bulur; otomatik kapanış 72 saati geçen
-- aktif seansları (ix_fasting_active_planned_end kapsar).
ALTER TABLE fasting_sessions ADD KEY ix_fasting_updated (updated_at);
