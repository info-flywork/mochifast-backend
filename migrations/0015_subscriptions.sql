-- 0015_subscriptions
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Abonelik (RevenueCat yansıması), webhook olayları ve bildirim kutusu (inbox)
-- (docs/backend/03-veri-modeli.md §3.9–3.10, 11-abonelik.md).

-- RevenueCat doğruluk kaynağıdır; bu tablo onun yansımasıdır (REST ile teyit edilerek yazılır).
CREATE TABLE subscriptions (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  entitlement        VARCHAR(40)  NOT NULL DEFAULT 'premium',
  product_id         VARCHAR(120) NULL,
  store              ENUM('app_store', 'play_store', 'promotional', 'stripe', 'amazon',
                          'mac_app_store', 'rc_billing', 'other') NULL,
  environment        ENUM('production', 'sandbox') NOT NULL DEFAULT 'production',
  period_type        ENUM('trial', 'intro', 'normal', 'promotional', 'prepaid') NULL,
  status             ENUM('active', 'in_grace', 'billing_issue', 'cancelled', 'expired', 'paused',
                          'refunded') NOT NULL,
  will_renew         TINYINT(1)   NOT NULL DEFAULT 0,
  purchased_at       DATETIME(3)  NULL,
  -- NULL = ömür boyu.
  expires_at         DATETIME(3)  NULL,
  grace_expires_at   DATETIME(3)  NULL,
  management_url     VARCHAR(500) NULL,
  last_synced_at     DATETIME(3)  NOT NULL,
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sub_user_entitlement (user_id, entitlement),
  KEY ix_sub_expires (status, expires_at),
  CONSTRAINT fk_sub_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Webhook olayları: event_id ile idempotent (aynı olay iki kez işlenmez).
CREATE TABLE revenuecat_events (
  event_id           VARCHAR(80)  NOT NULL,
  event_type         VARCHAR(40)  NOT NULL,
  app_user_id        VARCHAR(120) NOT NULL,
  environment        VARCHAR(20)  NOT NULL,
  payload            JSON         NOT NULL,
  received_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at       DATETIME(3)  NULL,
  error              VARCHAR(255) NULL,
  PRIMARY KEY (event_id),
  KEY ix_rc_user (app_user_id, received_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Bildirim kutusu (inbox). Şablonlar ve push gönderimi F9'da; türler şimdilik serbest metin.
CREATE TABLE notifications (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  type               VARCHAR(40)  NOT NULL,
  params             JSON         NULL,
  ref_type           VARCHAR(30)  NULL,
  ref_id             BINARY(16)   NULL,
  read_at            DATETIME(3)  NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_notif_user_list (user_id, deleted_at, created_at),
  KEY ix_notif_user_unread (user_id, read_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
