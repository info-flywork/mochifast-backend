-- 0007_plans_fasting
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Kullanıcı planı (docs/backend/03-veri-modeli.md §3.3), oruç seansları ve zorlanma olayları
-- (§3.4), Idempotency-Key kayıtları (§3.12).

CREATE TABLE user_plans (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  plan_id            SMALLINT UNSIGNED NOT NULL,
  timing             ENUM('skip_breakfast', 'skip_dinner', 'early_window', 'late_window', 'custom') NULL,
  -- Günlük hedef (haftalık planlarda zamanlayıcı başlatılırsa varsayılan).
  fast_minutes       SMALLINT UNSIGNED NOT NULL,
  eat_window_start   TIME         NULL,
  eat_window_end     TIME         NULL,
  -- 7 gün: [{dow:1, type:"fast|normal|reduced", fastMinutes?, kcal?}]
  weekly_schedule    JSON         NULL,
  safety_ack_at      DATETIME(3)  NULL,
  started_on         DATE         NOT NULL,
  ended_at           DATETIME(3)  NULL,
  is_current         TINYINT GENERATED ALWAYS AS (IF(ended_at IS NULL, 1, NULL)) STORED,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- Kullanıcı başına tek aktif plan.
  UNIQUE KEY uq_user_plans_current (user_id, is_current),
  KEY ix_user_plans_user (user_id, started_on),
  CONSTRAINT fk_user_plans_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_plans_plan FOREIGN KEY (plan_id) REFERENCES fasting_plans (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Haftalık planlarda azaltılmış/oruç günlerinin tutulup tutulmadığı (05 §2.2).
CREATE TABLE plan_day_checkins (
  user_id            BINARY(16)   NOT NULL,
  local_date         DATE         NOT NULL,
  day_type           ENUM('reduced', 'fast') NOT NULL,
  status             ENUM('done', 'skipped') NOT NULL,
  auto_suggested     TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, local_date),
  CONSTRAINT fk_plan_day_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE fasting_sessions (
  -- İstemci üretebilir (UUIDv7): çevrimdışı başlatılan oruç tekrar gönderilince yinelenmez.
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  user_plan_id       BINARY(16)   NULL,
  -- Anlık görüntü: plan sonra değişse de geçmiş doğru kalır.
  plan_code          VARCHAR(32)  NULL,
  target_minutes     SMALLINT UNSIGNED NOT NULL,
  status             ENUM('active', 'completed', 'ended_early', 'cancelled') NOT NULL DEFAULT 'active',
  started_at         DATETIME(3)  NOT NULL,
  planned_end_at     DATETIME(3)  NOT NULL,
  ended_at           DATETIME(3)  NULL,
  duration_minutes   SMALLINT UNSIGNED NULL,
  goal_reached       TINYINT(1)   NOT NULL DEFAULT 0,
  -- Seansın tüm süresi bitiş gününe sayılır (05 §1.4).
  end_local_date     DATE         NULL,
  start_local_date   DATE         NOT NULL,
  tz                 VARCHAR(64)  NOT NULL,
  feeling            ENUM('tough', 'meh', 'good', 'super') NULL,
  -- AES-256-GCM (infra/crypto.js), ≤ 1000 karakter.
  notes_enc          VARBINARY(4096) NULL,
  weight_entry_id    BINARY(16)   NULL,
  source             ENUM('app', 'widget', 'manual_log', 'import') NOT NULL DEFAULT 'app',
  auto_closed        TINYINT(1)   NOT NULL DEFAULT 0,
  active_marker      TINYINT GENERATED ALWAYS AS (IF(status = 'active', 1, NULL)) STORED,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3)  NULL,
  PRIMARY KEY (id),
  -- Kullanıcı başına tek aktif oruç (eşzamanlı başlatmada ikincisi bu kısıta takılır).
  UNIQUE KEY uq_fasting_one_active (user_id, active_marker),
  KEY ix_fasting_user_started (user_id, started_at),
  KEY ix_fasting_user_end_date (user_id, end_local_date, status),
  KEY ix_fasting_active_planned_end (status, planned_end_at),
  CONSTRAINT fk_fasting_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_fasting_user_plan FOREIGN KEY (user_plan_id) REFERENCES user_plans (id) ON DELETE SET NULL,
  CONSTRAINT ck_fasting_target CHECK (target_minutes BETWEEN 60 AND 4320)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE struggle_events (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  fasting_session_id BINARY(16)   NULL,
  reason             ENUM('hungry', 'craving', 'energy', 'stressed', 'bored') NOT NULL,
  tip                ENUM('hydration', 'walk', 'breathe') NULL,
  tip_completed      TINYINT(1)   NOT NULL DEFAULT 0,
  outcome            ENUM('keep_going', 'try_another', 'ended_fast') NULL,
  -- Olay anındaki oruç süresi (ileride tahmin modeli için).
  elapsed_minutes    SMALLINT UNSIGNED NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_struggle_user (user_id, created_at),
  CONSTRAINT fk_struggle_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_struggle_session FOREIGN KEY (fasting_session_id) REFERENCES fasting_sessions (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Idempotency-Key (02 §4.3): aynı anahtarla tekrar gelen isteğe ilk yanıt döner; 24 saat saklanır.
CREATE TABLE idempotency_keys (
  user_id            BINARY(16)   NOT NULL,
  idem_key           VARCHAR(64)  NOT NULL,
  -- SHA-256(method + yol + gövde); farklıysa 409 IDEMPOTENCY_KEY_REUSED.
  request_hash       CHAR(64)     NOT NULL,
  -- NULL = istek hâlâ işleniyor.
  status_code        SMALLINT UNSIGNED NULL,
  response_body      MEDIUMTEXT   NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at         DATETIME(3)  NOT NULL,
  PRIMARY KEY (user_id, idem_key),
  KEY ix_idem_expires (expires_at),
  CONSTRAINT fk_idem_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
