-- 0002_identity
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Kimlik, cihaz, oturum, rıza ve denetim kaydı (docs/backend/03-veri-modeli.md §3.1, §3.12).
-- Collation belirtilmez: sunucunun utf8mb4 varsayılanı kullanılır (MySQL 8 ve MariaDB uyumlu).

CREATE TABLE users (
  id                      BINARY(16)   NOT NULL,
  status                  ENUM('active', 'pending_deletion', 'deleted', 'banned') NOT NULL DEFAULT 'active',
  is_guest                TINYINT(1)   NOT NULL DEFAULT 1,
  display_name            VARCHAR(60)  NULL,
  -- Apple private relay olabilir; kimlik için KULLANILMAZ (kimlik = auth_identities.provider_subject).
  email                   VARCHAR(255) NULL,
  email_verified          TINYINT(1)   NOT NULL DEFAULT 0,
  avatar_media_id         BINARY(16)   NULL,
  locale                  VARCHAR(10)  NOT NULL DEFAULT 'en',
  timezone                VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  onboarding_completed_at DATETIME(3)  NULL,
  last_active_at          DATETIME(3)  NULL,
  created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at              DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_users_status_last_active (status, last_active_at),
  KEY ix_users_email (email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE auth_identities (
  id                      BINARY(16)   NOT NULL,
  user_id                 BINARY(16)   NOT NULL,
  provider                ENUM('apple', 'google', 'guest') NOT NULL,
  -- Apple/Google "sub"; misafir için install_id.
  provider_subject        VARCHAR(255) NOT NULL,
  email                   VARCHAR(255) NULL,
  -- Hesap silmede Apple /auth/revoke için (AES-256-GCM, infra/crypto.js).
  apple_refresh_token_enc VARBINARY(1024) NULL,
  created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at           DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_provider_subject (provider, provider_subject),
  KEY ix_auth_user (user_id),
  CONSTRAINT fk_auth_identities_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE devices (
  id                      BINARY(16)   NOT NULL,
  user_id                 BINARY(16)   NOT NULL,
  -- İstemcinin ürettiği kurulum UUID'si.
  install_id              CHAR(36)     NOT NULL,
  platform                ENUM('ios', 'android') NOT NULL,
  os_version              VARCHAR(32)  NULL,
  app_version             VARCHAR(32)  NULL,
  device_model            VARCHAR(64)  NULL,
  push_token              VARCHAR(512) NULL,
  push_enabled            TINYINT(1)   NOT NULL DEFAULT 1,
  locale                  VARCHAR(10)  NULL,
  timezone                VARCHAR(64)  NULL,
  last_seen_at            DATETIME(3)  NULL,
  created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_devices_user_install (user_id, install_id),
  KEY ix_devices_push_token (push_token(191)),
  CONSTRAINT fk_devices_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Refresh token oturumları: her yenilemede yeni satır (rotasyon), aynı girişten türeyenler aynı aile.
CREATE TABLE sessions (
  id                      BINARY(16)   NOT NULL,
  user_id                 BINARY(16)   NOT NULL,
  device_id               BINARY(16)   NULL,
  family_id               BINARY(16)   NOT NULL,
  -- SHA-256(refresh token); token'ın kendisi saklanmaz.
  token_hash              CHAR(64)     NOT NULL,
  replaced_by_id          BINARY(16)   NULL,
  expires_at              DATETIME(3)  NOT NULL,
  revoked_at              DATETIME(3)  NULL,
  revoke_reason           ENUM('logout', 'rotated', 'reuse_detected', 'account_deleted', 'admin', 'account_switched') NULL,
  ip                      VARBINARY(16) NULL,
  user_agent              VARCHAR(255) NULL,
  created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at            DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token_hash (token_hash),
  KEY ix_sessions_user (user_id, revoked_at),
  KEY ix_sessions_family (family_id),
  KEY ix_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_sessions_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Yalnızca ekleme (append-only); her tür için son kayıt geçerli durumdur.
CREATE TABLE user_consents (
  id                      BINARY(16)   NOT NULL,
  user_id                 BINARY(16)   NOT NULL,
  consent_type            ENUM('terms', 'privacy', 'health_data', 'ai_processing', 'marketing_push', 'analytics') NOT NULL,
  document_version        VARCHAR(20)  NOT NULL,
  granted                 TINYINT(1)   NOT NULL,
  source                  ENUM('onboarding', 'settings', 'prompt') NOT NULL,
  ip                      VARBINARY(16) NULL,
  created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_consents_user_type (user_id, consent_type, created_at),
  CONSTRAINT fk_consents_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Denetim izi. Kullanıcı silinse de kalır (FK yok); metadata PII içermez. 13 ay saklanır.
CREATE TABLE audit_logs (
  id                      BINARY(16)   NOT NULL,
  actor_type              ENUM('user', 'admin', 'system', 'webhook') NOT NULL,
  actor_id                BINARY(16)   NULL,
  action                  VARCHAR(60)  NOT NULL,
  entity_type             VARCHAR(40)  NULL,
  entity_id               VARCHAR(64)  NULL,
  ip                      VARBINARY(16) NULL,
  user_agent              VARCHAR(255) NULL,
  metadata                JSON         NULL,
  created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_actor (actor_type, actor_id, created_at),
  KEY ix_audit_entity (entity_type, entity_id),
  KEY ix_audit_time (created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
