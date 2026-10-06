import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { loadMigrationFiles, migrate } from '../../src/infra/migrator.js';
import { createTestDatabase, testConfig } from '../helpers/infra.js';

const mysqlUrl = inject('mysqlUrl');

describe('loadMigrationFiles', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mf-mig-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adlandırma kuralını ve yinelenen sürümü reddeder', async () => {
    await writeFile(path.join(dir, 'create_users.sql'), 'SELECT 1;');
    await expect(loadMigrationFiles(dir)).rejects.toThrow(/Geçersiz migration dosya adı/);
    await rm(path.join(dir, 'create_users.sql'));

    await writeFile(path.join(dir, '0001_a.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, '0001_b.sql'), 'SELECT 2;');
    await expect(loadMigrationFiles(dir)).rejects.toThrow(/Yinelenen/);
  });

  it("CRLF farkı checksum'ı değiştirmez", async () => {
    await writeFile(path.join(dir, '0001_a.sql'), 'SELECT 1;\r\nSELECT 2;\r\n');
    const [crlf] = await loadMigrationFiles(dir);
    await writeFile(path.join(dir, '0001_a.sql'), 'SELECT 1;\nSELECT 2;\n');
    const [lf] = await loadMigrationFiles(dir);
    expect(crlf.checksum).toBe(lf.checksum);
  });
});

describe.skipIf(!mysqlUrl)('migrate (gerçek MySQL)', () => {
  let testDb;
  let dir;
  let dbConfig;

  beforeEach(async () => {
    testDb = await createTestDatabase(mysqlUrl);
    dbConfig = testConfig(testDb.env).db;
    dir = await mkdtemp(path.join(tmpdir(), 'mf-mig-'));
    await writeFile(
      path.join(dir, '0001_create_widgets.sql'),
      'CREATE TABLE widgets (id INT PRIMARY KEY);\nINSERT INTO widgets VALUES (1);\n',
    );
    await writeFile(
      path.join(dir, '0002_add_name.sql'),
      'ALTER TABLE widgets ADD COLUMN name VARCHAR(20) NULL;\n',
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await testDb.drop();
  });

  async function query(sql) {
    const { host, port, user, password, database } = dbConfig;
    const conn = await mysql.createConnection({ host, port, user, password, database });
    try {
      const [rows] = await conn.query(sql);
      return rows;
    } finally {
      await conn.end();
    }
  }

  it('bekleyenleri sırayla uygular, tekrar çalıştırmada hiçbir şey yapmaz', async () => {
    const first = await migrate({ dbConfig, dir });
    expect(first.ran).toEqual([1, 2]);
    expect(await query('SELECT id, name FROM widgets')).toEqual([{ id: 1, name: null }]);

    const rows = await query(
      'SELECT version, name, checksum, duration_ms FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => [r.version, r.name])).toEqual([
      [1, 'create_widgets'],
      [2, 'add_name'],
    ]);
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);

    const second = await migrate({ dbConfig, dir });
    expect(second.ran).toEqual([]);
    expect(second.pending).toEqual([]);
  });

  it('dry-run uygulamaz, yalnızca listeler', async () => {
    const result = await migrate({ dbConfig, dir, dryRun: true });
    expect(result.pending.map((m) => m.file)).toEqual([
      '0001_create_widgets.sql',
      '0002_add_name.sql',
    ]);
    expect(result.ran).toEqual([]);
    await expect(query('SELECT 1 FROM widgets')).rejects.toThrow(/doesn't exist/);
  });

  it('uygulanmış dosya değiştirilirse HATA verir', async () => {
    await migrate({ dbConfig, dir });
    await writeFile(
      path.join(dir, '0001_create_widgets.sql'),
      'CREATE TABLE widgets (id BIGINT PRIMARY KEY);\n',
    );
    await expect(migrate({ dbConfig, dir })).rejects.toThrow(/DEĞİŞTİRİLMİŞ/);
  });

  it('uygulanmış en büyük sürümden küçük yeni dosya (sıra dışı) HATA verir', async () => {
    await rm(path.join(dir, '0001_create_widgets.sql'));
    await writeFile(
      path.join(dir, '0002_add_name.sql'),
      'CREATE TABLE widgets (id INT PRIMARY KEY);\n',
    );
    await migrate({ dbConfig, dir });
    await writeFile(path.join(dir, '0001_late.sql'), 'SELECT 1;\n');
    await expect(migrate({ dbConfig, dir })).rejects.toThrow(/Sıra dışı/);
  });

  it("eşzamanlı iki runner aynı migration'ı iki kez uygulamaz (GET_LOCK)", async () => {
    const results = await Promise.all([migrate({ dbConfig, dir }), migrate({ dbConfig, dir })]);
    expect(results.flatMap((r) => r.ran).sort()).toEqual([1, 2]);
    expect(await query('SELECT COUNT(*) AS n FROM schema_migrations')).toEqual([{ n: 2 }]);
  });

  it('hatalı migration kaydedilmez; düzeltilince devam eder', async () => {
    await writeFile(path.join(dir, '0003_broken.sql'), 'ALTER TABLE yok_boyle ADD COLUMN x INT;\n');
    await expect(migrate({ dbConfig, dir })).rejects.toThrow();
    expect(
      (await query('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version),
    ).toEqual([1, 2]);

    await writeFile(path.join(dir, '0003_broken.sql'), 'ALTER TABLE widgets ADD COLUMN x INT;\n');
    const fixed = await migrate({ dbConfig, dir });
    expect(fixed.ran).toEqual([3]);
  });
});
