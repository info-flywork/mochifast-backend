-- 0022_challenge_visibility
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Challenge katılımcı listesinde ad + avatar gösterimi için açık rıza (varsayılan kapalı).
-- Kapalıyken kullanıcı listede anonim görünür (docs/backend/05 §13).
ALTER TABLE user_settings
  ADD COLUMN show_in_challenges TINYINT(1) NOT NULL DEFAULT 0 AFTER health_sync_enabled;
