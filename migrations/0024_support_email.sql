-- 0024_support_email
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.

-- Profil → Destek ile iletişim: info@ → support@
UPDATE app_config
   SET value = '{"email":"support@fly-work.com"}'
 WHERE config_key = 'support'
   AND platform = 'all';
