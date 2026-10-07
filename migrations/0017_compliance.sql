-- 0017_compliance
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Hesap silme ve veri dışa aktarma talepleri (docs/backend/03-veri-modeli.md §3.12, 06 §8).
-- `audit_logs`, `user_consents` 0002'de; yönetici tabloları F10 2. haftada.

-- FK YOK: kullanıcı silindikten sonra da kalır (hukuki iz; user_id artık kişisel veri değildir).
CREATE TABLE account_deletion_requests (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  -- user = kullanıcı istedi; inactive_guest / guest_retired = saklama işi.
  source             ENUM('user', 'inactive_guest', 'guest_retired') NOT NULL DEFAULT 'user',
  requested_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  scheduled_for      DATETIME(3)  NOT NULL,
  status             ENUM('scheduled', 'cancelled', 'completed', 'failed') NOT NULL DEFAULT 'scheduled',
  reason             VARCHAR(255) NULL,
  last_error         VARCHAR(255) NULL,
  completed_at       DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_deletion_due (status, scheduled_for),
  KEY ix_deletion_user (user_id, status)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE data_export_requests (
  id                 BINARY(16)   NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  status             ENUM('queued', 'processing', 'ready', 'expired', 'failed') NOT NULL DEFAULT 'queued',
  -- Zip (private zone, `u/<ownerKey>/exports/`); 7 gün sonra silinir.
  media_id           BINARY(16)   NULL,
  bytes              INT UNSIGNED NULL,
  requested_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at       DATETIME(3)  NULL,
  expires_at         DATETIME(3)  NULL,
  last_error         VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY ix_export_user (user_id, requested_at),
  KEY ix_export_expiry (status, expires_at),
  CONSTRAINT fk_export_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_export_media FOREIGN KEY (media_id) REFERENCES media (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
