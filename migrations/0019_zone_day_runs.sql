-- 0019_zone_day_runs
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- Yerel güne bağlı günlük işler (bildirim planlayıcı, seri gün dönümü) her saat dilimi için her
-- yerel günü bir kez işler. "Yerel saat 0 mı?" kontrolü yerine: gece yarısının yaşanmadığı DST
-- günlerinde ve zamanlayıcı kayması/worker yeniden başlatması nedeniyle atlanan saatlerde de
-- gün kaçmaz (14 gün saklanır).
CREATE TABLE zone_day_runs (
  job                VARCHAR(40)  NOT NULL,
  timezone           VARCHAR(64)  NOT NULL,
  local_date         DATE         NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (job, timezone, local_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
