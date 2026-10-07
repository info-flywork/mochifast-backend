-- 0018_admin
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Yönetim paneli: yöneticiler, katalog dokümanları (sürümlü), günlük etkinlik (DAU/MAU)
-- (docs/backend/03-veri-modeli.md §3.12, 06 §12).

CREATE TABLE admin_users (
  id                 BINARY(16)   NOT NULL,
  email              VARCHAR(255) NOT NULL,
  -- argon2id (PHC biçimi: $argon2id$v=19$m=19456,t=2,p=1$…)
  password_hash      VARCHAR(255) NOT NULL,
  role               ENUM('owner', 'editor', 'support', 'analyst') NOT NULL,
  -- TOTP sırrı (alan şifreleme, infra/crypto.js); MFA zorunlu.
  totp_secret_enc    VARBINARY(256) NOT NULL,
  -- Aynı kod iki kez kullanılamaz: son kabul edilen 30 sn adımı.
  totp_last_step     BIGINT       NULL,
  failed_attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until       DATETIME(3)  NULL,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at      DATETIME(3)  NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_email (email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Katalog bölümlerinin seed biçimindeki dokümanları. Panelden kaydedilen bölüm (source=admin)
-- `npm run seed` tarafından ezilmez. Son sürüm geçerlidir; eski sürümler geri alma içindir.
CREATE TABLE catalog_documents (
  section            VARCHAR(40)  NOT NULL,
  version            INT UNSIGNED NOT NULL,
  source             ENUM('seed', 'admin') NOT NULL,
  document           LONGTEXT     NOT NULL,
  sha256             CHAR(64)     NOT NULL,
  admin_id           BINARY(16)   NULL,
  note               VARCHAR(255) NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (section, version)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Günlük etkin kullanıcı (UTC günü). Raporlar: DAU/WAU/MAU. 400 gün saklanır.
CREATE TABLE user_activity_daily (
  activity_date      DATE         NOT NULL,
  user_id            BINARY(16)   NOT NULL,
  PRIMARY KEY (activity_date, user_id),
  KEY ix_activity_user (user_id),
  CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
