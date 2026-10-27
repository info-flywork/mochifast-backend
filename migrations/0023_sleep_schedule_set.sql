-- 0023_sleep_schedule_set
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Uyku programı (yatış / uyanış / hedef) kolonları NOT NULL varsayılanlı: kullanıcının kendisi
-- ayarlayıp ayarlamadığı ayırt edilemiyordu; uygulama hiç ayarlanmamış programı gerçekmiş gibi
-- gösteriyordu. İlk kez PATCH /user/goals ile yazılınca dolar; NULL = hiç ayarlanmadı.
ALTER TABLE user_goals ADD COLUMN sleep_schedule_set_at DATETIME(3) NULL AFTER wake_time;
