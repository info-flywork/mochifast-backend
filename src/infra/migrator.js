import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { SESSION_INIT_SQL, sslOptions } from './db.js';

/**
 * mysql2 tabanlı, yalnızca İLERİ yönlü migration aracı (docs/backend/02-mimari.md §3.3).
 * - Dosyalar: `NNNN_aciklama.sql` (4 hane, küçük harf/rakam/alt çizgi)
 * - `schema_migrations`'ta checksum tutulur; uygulanmış bir dosya değiştirilirse HATA
 * - `GET_LOCK` ile aynı anda iki runner çalışamaz
 * - Uygulanmış en büyük sürümden küçük yeni dosya (sıra dışı) HATA
 * Not: MySQL DDL'i örtük commit yapar; dosyalar küçük ve tek amaçlı tutulmalı. Yarıda kalan
 * bir dosya `schema_migrations`'a yazılmaz → elle düzeltip yeniden çalıştırılır.
 */

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const LOCK_NAME = 'mochifast_schema_migrations';
const LOCK_TIMEOUT_SEC = 60;

export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INT UNSIGNED NOT NULL,
  name        VARCHAR(200) NOT NULL,
  checksum    CHAR(64)     NOT NULL,
  applied_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  duration_ms INT UNSIGNED NOT NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

export async function loadMigrationFiles(dir) {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files = [];
  const seen = new Set();
  for (const file of entries) {
    const match = FILE_PATTERN.exec(file);
    if (!match)
      throw new Error(`Geçersiz migration dosya adı: ${file} (beklenen: 0001_aciklama.sql)`);
    const version = Number(match[1]);
    if (seen.has(version)) throw new Error(`Yinelenen migration sürümü: ${match[1]}`);
    seen.add(version);
    const sql = (await readFile(path.join(dir, file), 'utf8')).replace(/\r\n/g, '\n');
    if (!sql.trim()) throw new Error(`Boş migration dosyası: ${file}`);
    files.push({ version, name: match[2], file, sql, checksum: sha256(sql) });
  }
  return files;
}

/**
 * @param [options.dryRun] yalnızca listele
 */
export async function migrate({ dbConfig, dir, dryRun = false, logger }) {
  const files = await loadMigrationFiles(dir);
  const conn = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    multipleStatements: true, // yalnızca bu bağlantıda: migration dosyaları çok ifadelidir
    timezone: 'Z',
    charset: 'UTF8MB4_0900_AI_CI',
    ssl: sslOptions(dbConfig),
  });

  try {
    await conn.query(SESSION_INIT_SQL);
    await conn.query(SCHEMA_MIGRATIONS_DDL);

    const [[lock]] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [
      LOCK_NAME,
      LOCK_TIMEOUT_SEC,
    ]);
    if (lock.acquired !== 1) {
      throw new Error('Migration kilidi alınamadı: başka bir migration çalışıyor olabilir.');
    }

    try {
      const [rows] = await conn.query(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      );
      const appliedRows = rows;
      const byVersion = new Map(files.map((f) => [f.version, f]));

      for (const row of appliedRows) {
        const file = byVersion.get(row.version);
        if (!file) {
          throw new Error(
            `Uygulanmış migration ${pad(row.version)}_${row.name} dosyası bulunamadı.`,
          );
        }
        if (file.checksum !== row.checksum) {
          throw new Error(
            `${file.file} uygulandıktan sonra DEĞİŞTİRİLMİŞ (checksum uyuşmuyor). ` +
              'Uygulanmış migration düzenlenmez; yeni bir migration ekleyin.',
          );
        }
      }

      const appliedSet = new Set(appliedRows.map((r) => r.version));
      const maxApplied = appliedRows.reduce((max, r) => Math.max(max, r.version), 0);
      const pending = files.filter((f) => !appliedSet.has(f.version));
      const outOfOrder = pending.filter((f) => f.version < maxApplied);
      if (outOfOrder.length > 0) {
        throw new Error(
          `Sıra dışı migration: ${outOfOrder.map((f) => f.file).join(', ')} ` +
            `(uygulanmış en büyük sürüm ${pad(maxApplied)}). Dosyayı yeniden numaralandırın.`,
        );
      }

      const ran = [];
      if (!dryRun) {
        for (const m of pending) {
          const started = Date.now();
          await conn.query(m.sql);
          const durationMs = Date.now() - started;
          await conn.query(
            'INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES (?, ?, ?, ?)',
            [m.version, m.name, m.checksum, durationMs],
          );
          ran.push(m.version);
          logger?.info({ migration: m.file, durationMs }, 'migration uygulandı');
        }
      }
      return { applied: [...appliedSet], pending, ran };
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    await conn.end();
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function pad(n) {
  return String(n).padStart(4, '0');
}
