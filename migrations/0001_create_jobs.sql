-- 0001_create_jobs
-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.
-- MySQL tabanlı iş kuyruğu ve tekrarlı iş zamanlamaları (docs/adr/0005-redis-yok.md).

CREATE TABLE jobs (
  id           BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  queue        VARCHAR(32)       NOT NULL,
  name         VARCHAR(64)       NOT NULL,
  payload      JSON              NOT NULL,
  status       ENUM('pending', 'running', 'done', 'failed') NOT NULL DEFAULT 'pending',
  attempts     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  run_at       DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_by    VARCHAR(64)       NULL,
  locked_until DATETIME(3)       NULL,
  -- Aynı anahtarla ikinci kez kuyruğa atılamaz (satır silinene kadar). NULL = sınırsız.
  dedupe_key   VARCHAR(191)      NULL,
  last_error   VARCHAR(2000)     NULL,
  created_at   DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at  DATETIME(3)       NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jobs_queue_dedupe (queue, dedupe_key),
  KEY ix_jobs_claim (queue, status, run_at),
  KEY ix_jobs_lock (status, locked_until),
  KEY ix_jobs_finished (status, finished_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE job_schedules (
  id          VARCHAR(64)  NOT NULL,
  queue       VARCHAR(32)  NOT NULL,
  name        VARCHAR(64)  NOT NULL,
  every_ms    INT UNSIGNED NOT NULL,
  next_run_at DATETIME(3)  NOT NULL,
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_job_schedules_due (next_run_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
