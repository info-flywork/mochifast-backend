-- 0021_guest_secret
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Misafir sırrı (F11 güvenlik denetimi, bulgu 7): misafire yalnızca installId ile girilemez.
-- Sır oluşturulurken bir kez döner; burada SHA-256'sı tutulur. NULL = eski misafir (ilk girişte
-- sır verilir).
ALTER TABLE auth_identities ADD COLUMN secret_hash CHAR(64) NULL AFTER provider_subject;
