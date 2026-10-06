import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase } from '../../src/infra/db.js';
import { fromBin, newId, toBin } from '../../src/shared/ids.js';
import { createTestDatabase, testConfig } from '../helpers/infra.js';

const mysqlUrl = inject('mysqlUrl');

describe.skipIf(!mysqlUrl)('infra/db (gerçek MySQL)', () => {
  let testDb;
  let db;

  beforeAll(async () => {
    testDb = await createTestDatabase(mysqlUrl);
    db = createDatabase(testConfig(testDb.env).db);
    await db.run(`
      CREATE TABLE samples (
        id         BINARY(16)   NOT NULL PRIMARY KEY,
        name       VARCHAR(40)  NOT NULL,
        weight_kg  DECIMAL(5,2) NULL,
        is_active  TINYINT(1)   NULL,
        created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB`);
  });

  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  it('ping', async () => {
    await expect(db.ping()).resolves.toBeUndefined();
  });

  it('oturum saat dilimi UTC', async () => {
    const row = await db.one('SELECT @@session.time_zone AS tz');
    expect(row?.tz).toBe('+00:00');
  });

  it('named placeholder, BINARY(16) UUID, DECIMAL→number, TINYINT(1)→boolean, NULL korunur', async () => {
    const id = newId();
    await db.run(
      'INSERT INTO samples (id, name, weight_kg, is_active) VALUES (:id, :name, :w, :a)',
      {
        id: toBin(id),
        name: 'mochi',
        w: 74.25,
        a: 1,
      },
    );
    await db.run('INSERT INTO samples (id, name) VALUES (?, ?)', [toBin(newId()), 'boş']);

    const row = await db.one(
      'SELECT id, name, weight_kg, is_active, created_at FROM samples WHERE id = ?',
      [toBin(id)],
    );
    expect(fromBin(row?.id)).toBe(id);
    expect(row?.weight_kg).toBe(74.25);
    expect(row?.is_active).toBe(true);
    expect(row?.created_at).toBeInstanceOf(Date);
    expect(Math.abs(row?.created_at.getTime() - Date.now())).toBeLessThan(60_000); // UTC tutarlı

    const empty = await db.one('SELECT weight_kg, is_active FROM samples WHERE name = ?', ['boş']);
    expect(empty).toEqual({ weight_kg: null, is_active: null });
  });

  it('enjeksiyon denemesi veri olarak kalır', async () => {
    const evil = "x'); DROP TABLE samples; --";
    await db.run('INSERT INTO samples (id, name) VALUES (?, ?)', [
      toBin(newId()),
      evil.slice(0, 40),
    ]);
    const rows = await db.many('SELECT name FROM samples WHERE name = ?', [evil.slice(0, 40)]);
    expect(rows).toHaveLength(1);
  });

  it('withTransaction: başarıda commit, hatada rollback', async () => {
    const committed = newId();
    await db.withTransaction(async (conn) => {
      await db.run(
        'INSERT INTO samples (id, name) VALUES (?, ?)',
        [toBin(committed), 'commit'],
        conn,
      );
    });
    expect(await db.one('SELECT name FROM samples WHERE id = ?', [toBin(committed)])).toEqual({
      name: 'commit',
    });

    const rolledBack = newId();
    await expect(
      db.withTransaction(async (conn) => {
        await db.run(
          'INSERT INTO samples (id, name) VALUES (?, ?)',
          [toBin(rolledBack), 'geri'],
          conn,
        );
        throw new Error('iş kuralı ihlali');
      }),
    ).rejects.toThrow('iş kuralı ihlali');
    expect(await db.one('SELECT name FROM samples WHERE id = ?', [toBin(rolledBack)])).toBeNull();
  });

  it('havuz istatistikleri okunabilir', () => {
    const stats = db.poolStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.queued).toBe(0);
  });
});
