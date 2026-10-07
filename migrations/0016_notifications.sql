-- 0016_notifications
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Bildirim şablonları, zamanlama (tek doğru kaynak) ve push teslim kaydı
-- (docs/backend/03-veri-modeli.md §3.9, 10-bildirimler.md). `notifications` (inbox) 0015'te.

CREATE TABLE notification_templates (
  type               VARCHAR(40)  NOT NULL,
  channel            SET('push', 'inbox') NOT NULL,
  category           ENUM('fasting', 'streak', 'weight', 'water', 'challenge', 'world', 'system',
                          'marketing') NOT NULL,
  -- Sessiz saatlerde: defer = sessiz saat bitişine ertele (hatırlatıcılar); silent = sessiz
  -- gönder (inbox + sessiz push); send = normal gönder.
  quiet_hours        ENUM('defer', 'silent', 'send') NOT NULL DEFAULT 'defer',
  -- Ertelenen hatırlatıcı bu süreden fazla gecikecekse atlanır (anlamını yitirir).
  max_delay_min      SMALLINT UNSIGNED NULL,
  priority           TINYINT UNSIGNED NOT NULL DEFAULT 5,
  deep_link          VARCHAR(160) NULL,
  icon_key           VARCHAR(40)  NULL,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (type)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE notification_template_translations (
  type               VARCHAR(40)  NOT NULL,
  locale             VARCHAR(10)  NOT NULL,
  -- Yer tutucular: {name}, {weightKg}, {streak}, {planName}, {zone}, {level}, {challenge}
  title              VARCHAR(120) NOT NULL,
  body               VARCHAR(400) NOT NULL,
  PRIMARY KEY (type, locale),
  CONSTRAINT fk_ntpl_tr FOREIGN KEY (type) REFERENCES notification_templates (type) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Zamanlanmış gönderimlerin tek doğru kaynağı. Anlık olaylar da buradan geçer (fire_at = şimdi):
-- iptal/yeniden planlama tek UPDATE, dedupe_key ile aynı bildirim iki kez gitmez.
CREATE TABLE scheduled_notifications (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  type               VARCHAR(40)  NOT NULL,
  fire_at            DATETIME(3)  NOT NULL,
  params             JSON         NULL,
  dedupe_key         VARCHAR(120) NOT NULL,
  status             ENUM('scheduled', 'processing', 'sent', 'cancelled', 'skipped', 'failed')
                     NOT NULL DEFAULT 'scheduled',
  attempts           TINYINT UNSIGNED NOT NULL DEFAULT 0,
  -- Atlanma/hata sebebi (ayar, sessiz saat, sınır, artık geçersiz…).
  last_error         VARCHAR(255) NULL,
  sent_at            DATETIME(3)  NULL,
  -- Gönderildiği kategori (frekans sınırı sayımı şablona join gerektirmesin).
  category           VARCHAR(20)  NULL,
  pushed             TINYINT(1)   NOT NULL DEFAULT 0,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sched_dedupe (user_id, dedupe_key),
  KEY ix_sched_due (status, fire_at),
  KEY ix_sched_user_sent (user_id, status, sent_at),
  CONSTRAINT fk_sched_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Push teslim kaydı (30 gün saklanır).
CREATE TABLE push_deliveries (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  device_id          BINARY(16)   NULL,
  type               VARCHAR(40)  NOT NULL,
  status             ENUM('sent', 'failed', 'invalid_token') NOT NULL,
  provider_message_id VARCHAR(160) NULL,
  error_code         VARCHAR(80)  NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_push_user_time (user_id, created_at),
  KEY ix_push_time (created_at),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Dünya bildirimleri için ayrı kategori anahtarı.
ALTER TABLE user_settings ADD COLUMN notif_world TINYINT(1) NOT NULL DEFAULT 1 AFTER notif_challenges;
