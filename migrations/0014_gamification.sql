-- 0014_gamification
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Mochi World ve challenge'lar (docs/backend/03-veri-modeli.md §3.7, 05-is-kurallari.md §7, §13).

-- Bölge eşikleri (seed ile; yönetilebilir).
CREATE TABLE world_zone_thresholds (
  zone               ENUM('forest', 'lake', 'summit', 'garden') NOT NULL,
  level              TINYINT UNSIGNED NOT NULL,
  threshold          DECIMAL(8,2) NOT NULL,
  PRIMARY KEY (zone, level)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Kullanıcının bölge durumu. Metrik ham verilerden hesaplanır; ada görsel olarak geri gitmez:
-- ulaşılan en yüksek seviye ayrıca tutulur.
CREATE TABLE user_world_zones (
  user_id            BINARY(16)   NOT NULL,
  zone               ENUM('forest', 'lake', 'summit', 'garden') NOT NULL,
  current_value      DECIMAL(8,2) NOT NULL DEFAULT 0,
  max_level_reached  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, zone),
  CONSTRAINT fk_world_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE challenges (
  id                 SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code               VARCHAR(40)  NOT NULL,
  metric             ENUM('meals_logged', 'fasts_completed', 'water_goal_days', 'streak_days',
                          'hunger_checkins') NOT NULL,
  target_count       SMALLINT UNSIGNED NOT NULL,
  duration_days      SMALLINT UNSIGNED NOT NULL,
  -- rolling: katılınca başlar; fixed: herkes için aynı pencere.
  window_type        ENUM('rolling', 'fixed') NOT NULL DEFAULT 'rolling',
  starts_at          DATETIME(3)  NULL,
  ends_at            DATETIME(3)  NULL,
  is_premium         TINYINT(1)   NOT NULL DEFAULT 0,
  is_featured        TINYINT(1)   NOT NULL DEFAULT 0,
  reward_xp          SMALLINT UNSIGNED NOT NULL DEFAULT 50,
  image_media_id     BINARY(16)   NULL,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order         SMALLINT     NOT NULL DEFAULT 0,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_challenges_code (code),
  CONSTRAINT ck_challenge_window CHECK (window_type = 'rolling' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL))
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE challenge_translations (
  challenge_id       SMALLINT UNSIGNED NOT NULL,
  locale             VARCHAR(10)  NOT NULL,
  title              VARCHAR(120) NOT NULL,
  subtitle           VARCHAR(200) NOT NULL,
  badge_label        VARCHAR(20)  NULL,
  description        TEXT         NULL,
  PRIMARY KEY (challenge_id, locale),
  CONSTRAINT fk_challenge_tr FOREIGN KEY (challenge_id) REFERENCES challenges (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Katılımcı sayısı denormalize edilmez: gerçek sayı sorguyla (05 §13; şişirilmiş sayı yok).
CREATE TABLE challenge_participants (
  id                 BINARY(16)   NOT NULL,
  challenge_id       SMALLINT UNSIGNED NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  window_start       DATETIME(3)  NOT NULL,
  window_end         DATETIME(3)  NOT NULL,
  progress_count     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  status             ENUM('active', 'completed', 'failed', 'left') NOT NULL DEFAULT 'active',
  completed_at       DATETIME(3)  NULL,
  -- Kullanıcı başına bir challenge'ta tek aktif katılım.
  active_marker      TINYINT GENERATED ALWAYS AS (IF(status = 'active', 1, NULL)) STORED,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_challenge_active (challenge_id, user_id, active_marker),
  KEY ix_challenge_part_user (user_id, status),
  KEY ix_challenge_part_window (status, window_end),
  KEY ix_challenge_part_challenge (challenge_id, status),
  CONSTRAINT fk_cp_challenge FOREIGN KEY (challenge_id) REFERENCES challenges (id),
  CONSTRAINT fk_cp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
