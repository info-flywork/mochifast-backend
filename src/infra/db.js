import mysql from 'mysql2/promise';

/**
 * mysql2 havuzu + yardımcılar (docs/backend/02-mimari.md §3.2).
 *
 * Kurallar:
 * - Kullanıcı girdisi HER ZAMAN placeholder ile geçer (`execute`, sunucu tarafı prepared statement).
 * - Kullanıcıya ait her sorgu `user_id` ile kapsanır (IDOR).
 * - `SELECT *` yok; kolonlar açıkça yazılır.
 */

/**
 * TINYINT(1) → boolean. NULL korunur. Diğer tipler mysql2 varsayılanı.
 */
const typeCast = (field, next) => {
  if (field.type === 'TINY' && field.length === 1) {
    const value = field.string();
    return value === null ? null : value === '1';
  }
  return next();
};

/**
 * mysql2 TLS ayarı. `sslVerify=false` yalnızca geliştirmede, kendinden imzalı sertifikalı uzak
 * sunucu için: trafik şifrelenir ama sunucunun kimliği doğrulanmaz (config üretimde reddeder).
 */
export function sslOptions(dbConfig) {
  if (!dbConfig.ssl) return undefined;
  if (dbConfig.sslVerify === false) return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, ...(dbConfig.sslCa ? { ca: dbConfig.sslCa } : {}) };
}

export function createDatabase(dbConfig, { logger } = {}) {
  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    connectionLimit: dbConfig.poolSize,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    connectTimeout: 10_000,
    timezone: 'Z', // JS Date ↔ DATETIME dönüşümü UTC
    dateStrings: false,
    decimalNumbers: true, // DECIMAL → number (kilo, makro)
    supportBigNumbers: true,
    namedPlaceholders: true,
    multipleStatements: false, // enjeksiyon yüzeyini daralt (migration aracı ayrı bağlantı kullanır)
    charset: 'UTF8MB4_0900_AI_CI',
    typeCast,
    ssl: sslOptions(dbConfig),
  });

  // Oturum saat dilimi de UTC olsun: NOW(3), CURRENT_TIMESTAMP(3) UTC üretir.
  pool.pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });

  async function timed(target, sql, params) {
    const started = performance.now();
    try {
      return await target.execute(sql, params ?? []);
    } finally {
      const ms = performance.now() - started;
      if (ms > dbConfig.slowQueryMs) {
        logger?.warn(
          { ms: Math.round(ms), sql: sql.replace(/\s+/g, ' ').slice(0, 300) },
          'slow query',
        );
      }
    }
  }

  const db = {
    pool,
    async many(sql, params, conn) {
      const [rows] = await timed(conn ?? pool, sql, params);
      return rows;
    },
    async one(sql, params, conn) {
      const [rows] = await timed(conn ?? pool, sql, params);
      const list = rows;
      return list.length > 0 ? list[0] : null;
    },
    async run(sql, params, conn) {
      const [result] = await timed(conn ?? pool, sql, params);
      return result;
    },
    async withTransaction(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    poolStats() {
      // mysql2 iç alanları: sürüm değişirse 0 döner, metrik bozulur ama uygulama çalışır.
      const inner = pool.pool;
      return {
        total: inner._allConnections?.length ?? 0,
        free: inner._freeConnections?.length ?? 0,
        queued: inner._connectionQueue?.length ?? 0,
      };
    },
    async close() {
      await pool.end();
    },
  };
  return db;
}
