-- 0020_admin_sessions
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Yönetici token iptali, geçici şifre zorunlu değişimi ve kullanıcı oturumu mutlak ömrü
-- (F11 güvenlik denetimi).
ALTER TABLE admin_users
  -- Bu andan önce verilmiş yönetici token'ları geçersiz (çıkış, şifre değişimi, sıfırlama, pasif).
  ADD COLUMN tokens_valid_after DATETIME(3) NULL AFTER locked_until,
  -- Geçici şifreyle girişte yalnızca şifre değiştirme uçları açık.
  ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 1 AFTER tokens_valid_after;

-- Oturum ailesinin başladığı an (ilk giriş): rotasyonla taşınır; aile REFRESH_ABSOLUTE_DAYS'ten
-- eskiyse yenileme reddedilir (yeniden kimlik doğrulama). NULL = eski satır (oluşturulma anı).
ALTER TABLE sessions ADD COLUMN family_started_at DATETIME(3) NULL AFTER family_id;
