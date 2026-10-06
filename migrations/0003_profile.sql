-- 0003_profile
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Profil, onboarding, ayarlar, hedefler (docs/backend/03-veri-modeli.md §3.2).
-- Onboarding kilo kaydı ve /user/progress için weight_entries (§3.6) ve user_stats (§3.7) de burada.

CREATE TABLE user_profiles (
  user_id               BINARY(16)   NOT NULL,
  gender                ENUM('woman', 'man', 'non_binary', 'prefer_not_to_say') NULL,
  -- Onboarding'deki yaştan türetilir (yaş zamanla eskimez).
  birth_year            SMALLINT UNSIGNED NULL,
  height_cm             DECIMAL(5,1) NULL,
  start_weight_kg       DECIMAL(5,2) NULL,
  goal_weight_kg        DECIMAL(5,2) NULL,
  goal                  ENUM('lose_weight', 'build_habit', 'more_energy', 'gut_reset') NULL,
  diet                  ENUM('everything', 'vegetarian', 'pescatarian', 'vegan', 'low_carb', 'mediterranean') NULL,
  weight_history        ENUM('many_times', 'once_or_twice', 'first_time') NULL,
  fasting_reason        ENUM('special_date', 'trip', 'health_longevity', 'confidence') NULL,
  target_date           DATE NULL,
  weekly_loss_target_kg DECIMAL(3,2) NOT NULL DEFAULT 0.40,
  meal_window_start     TIME NULL,
  meal_window_end       TIME NULL,
  -- Seçilen plan; aktif plan (user_plans) F3'te bağlanana kadar burada tutulur.
  plan_code             VARCHAR(32)  NULL,
  health_flags          SET('pregnant', 'breastfeeding', 'eating_disorder_history', 'diabetes',
                            'medication', 'under_18', 'heart_condition') NOT NULL DEFAULT '',
  health_screened_at    DATETIME(3)  NULL,
  weight_unit           ENUM('kg', 'lb') NOT NULL DEFAULT 'kg',
  height_unit           ENUM('cm', 'ft_in') NOT NULL DEFAULT 'cm',
  water_unit            ENUM('ml', 'oz') NOT NULL DEFAULT 'ml',
  updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE user_food_preferences (
  user_id               BINARY(16)   NOT NULL,
  pref_type             ENUM('love', 'skip') NOT NULL,
  -- src/config/constants.js FOOD_LOVES / FOOD_SKIPS listesiyle doğrulanır (snake_case).
  food_code             VARCHAR(32)  NOT NULL,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, pref_type, food_code),
  CONSTRAINT fk_food_prefs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE user_obstacles (
  user_id               BINARY(16)   NOT NULL,
  obstacle              ENUM('too_restrictive', 'lost_motivation', 'no_time_to_cook', 'too_confusing',
                             'life_got_busy', 'hit_plateau') NOT NULL,
  PRIMARY KEY (user_id, obstacle),
  CONSTRAINT fk_obstacles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Onboarding'in ham, sürümlü anlık görüntüsü (analitik & hata ayıklama).
CREATE TABLE onboarding_submissions (
  id                    BINARY(16)   NOT NULL,
  user_id               BINARY(16)   NOT NULL,
  schema_version        SMALLINT UNSIGNED NOT NULL,
  payload               JSON         NOT NULL,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_onboarding_user (user_id, created_at),
  CONSTRAINT fk_onboarding_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE user_settings (
  user_id                     BINARY(16) NOT NULL,
  push_enabled                TINYINT(1) NOT NULL DEFAULT 1,
  notif_fasting               TINYINT(1) NOT NULL DEFAULT 1,
  notif_streak                TINYINT(1) NOT NULL DEFAULT 1,
  notif_weight                TINYINT(1) NOT NULL DEFAULT 1,
  notif_water                 TINYINT(1) NOT NULL DEFAULT 0,
  notif_challenges            TINYINT(1) NOT NULL DEFAULT 1,
  notif_marketing             TINYINT(1) NOT NULL DEFAULT 0,
  water_reminder_interval_min SMALLINT UNSIGNED NOT NULL DEFAULT 120,
  quiet_hours_start           TIME NOT NULL DEFAULT '22:30:00',
  quiet_hours_end             TIME NOT NULL DEFAULT '08:00:00',
  health_sync_enabled         TINYINT(1) NOT NULL DEFAULT 0,
  updated_at                  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE user_goals (
  user_id               BINARY(16) NOT NULL,
  water_goal_ml         SMALLINT UNSIGNED NOT NULL DEFAULT 2500,
  glass_size_ml         SMALLINT UNSIGNED NOT NULL DEFAULT 300,
  custom_glass_sizes    JSON NULL,
  steps_goal            MEDIUMINT UNSIGNED NOT NULL DEFAULT 8000,
  -- NULL = sunucu hesaplar (docs/backend/05-is-kurallari.md §6).
  kcal_goal             SMALLINT UNSIGNED NULL,
  protein_goal_g        SMALLINT UNSIGNED NULL,
  carbs_goal_g          SMALLINT UNSIGNED NULL,
  fat_goal_g            SMALLINT UNSIGNED NULL,
  sleep_goal_min        SMALLINT UNSIGNED NOT NULL DEFAULT 450,
  bedtime               TIME NOT NULL DEFAULT '23:00:00',
  wake_time             TIME NOT NULL DEFAULT '06:30:00',
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_goals_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE weight_entries (
  id                    BINARY(16)   NOT NULL,
  user_id               BINARY(16)   NOT NULL,
  weight_kg             DECIMAL(5,2) NOT NULL,
  recorded_at           DATETIME(3)  NOT NULL,
  local_date            DATE         NOT NULL,
  tz                    VARCHAR(64)  NOT NULL,
  source                ENUM('manual', 'onboarding', 'fasting_finish', 'apple_health', 'google_fit') NOT NULL DEFAULT 'manual',
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at            DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_weight_user_time (user_id, recorded_at),
  CONSTRAINT fk_weight_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT ck_weight_range CHECK (weight_kg BETWEEN 25 AND 350)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Birikimli istatistikler; F3'ten itibaren oruç/seri hesaplarıyla dolar.
CREATE TABLE user_stats (
  user_id                 BINARY(16)   NOT NULL,
  current_streak          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  best_streak             SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  streak_last_date        DATE NULL,
  completed_fasts         INT UNSIGNED NOT NULL DEFAULT 0,
  total_fasts             INT UNSIGNED NOT NULL DEFAULT 0,
  total_fasted_minutes    INT UNSIGNED NOT NULL DEFAULT 0,
  longest_fast_minutes    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  meals_logged            INT UNSIGNED NOT NULL DEFAULT 0,
  water_goal_days         INT UNSIGNED NOT NULL DEFAULT 0,
  best_weight_lost_kg     DECIMAL(5,2) NOT NULL DEFAULT 0,
  xp                      INT UNSIGNED NOT NULL DEFAULT 0,
  level                   SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  world_health            ENUM('thriving', 'wilting', 'drought') NOT NULL DEFAULT 'thriving',
  first_fast_completed_at DATETIME(3)  NULL,
  updated_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_stats_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
