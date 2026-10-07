-- 0011_media
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Medya kayıtları (docs/backend/03-veri-modeli.md §3.11, 08-medya-bunny.md).

CREATE TABLE media (
  id                 BINARY(16)   NOT NULL,
  -- NULL = yönetici içeriği; kullanıcı silinince de NULL olur (yetim satırı temizlik işi siler).
  owner_user_id      BINARY(16)   NULL,
  purpose            ENUM('avatar', 'meal_photo', 'insight_cover', 'challenge_image', 'plan_image',
                          'data_export') NOT NULL,
  visibility         ENUM('private', 'public') NOT NULL,
  -- Varyantların ortak öneki, ör. 'u/<ownerKey>/meals/2026/10/<id>' (PII içermez).
  storage_path       VARCHAR(400) NOT NULL,
  -- {"thumb":"<prefix>_256.webp","md":"<prefix>_1024.webp"}
  variants           JSON         NULL,
  -- Daima image/webp (yeniden kodlanmış); orijinal saklanmaz.
  mime               VARCHAR(40)  NOT NULL,
  bytes              INT UNSIGNED NOT NULL,
  width              SMALLINT UNSIGNED NULL,
  height             SMALLINT UNSIGNED NULL,
  blurhash           VARCHAR(64)  NULL,
  -- Yüklenen orijinalin özeti: aynı kullanıcının yinelenen yüklemesini yakalar.
  sha256             CHAR(64)     NOT NULL,
  status             ENUM('processing', 'ready', 'failed', 'deleted') NOT NULL DEFAULT 'processing',
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_media_owner (owner_user_id, purpose, created_at),
  KEY ix_media_owner_hash (owner_user_id, sha256),
  KEY ix_media_status (status, created_at),
  CONSTRAINT fk_media_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

ALTER TABLE users
  ADD CONSTRAINT fk_users_avatar FOREIGN KEY (avatar_media_id) REFERENCES media (id) ON DELETE SET NULL;

ALTER TABLE meals
  ADD KEY ix_meals_photo (photo_media_id),
  ADD CONSTRAINT fk_meals_photo FOREIGN KEY (photo_media_id) REFERENCES media (id) ON DELETE SET NULL;
