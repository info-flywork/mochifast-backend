-- 0004_firebase_identity
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Apple/Google girişi Firebase Authentication üzerinden: kimlik = Firebase uid.
-- Apple token iptali (hesap silme) istemcideki Firebase SDK ile yapılır; sunucuda Apple
-- refresh token'ı saklanmaz.

ALTER TABLE auth_identities
  MODIFY provider ENUM('apple', 'google', 'guest', 'firebase') NOT NULL,
  ADD COLUMN sign_in_provider VARCHAR(32) NULL AFTER provider_subject,
  DROP COLUMN apple_refresh_token_enc;
