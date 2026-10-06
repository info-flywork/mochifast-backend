import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import mysql from 'mysql2/promise';
import { loadConfig } from '../../src/config/index.js';

/** Testlere özel, her çalıştırmada yeni üretilen anahtarlar. */
const jwtPair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
export const TEST_SECRETS = {
  JWT_PRIVATE_JWK: JSON.stringify({ ...(await exportJWK(jwtPair.privateKey)), kid: 'test-1' }),
  JWT_PUBLIC_JWKS: JSON.stringify([{ ...(await exportJWK(jwtPair.publicKey)), kid: 'test-1' }]),
  FIELD_ENCRYPTION_KEYS_JSON: JSON.stringify({ 1: randomBytes(32).toString('base64') }),
  FIELD_ENCRYPTION_ACTIVE_KID: '1',
};

/**
 * Testler için doğrulanmış konfigürasyon. Altyapı adresleri verilmezse yer tutucu kullanılır
 * (altyapıya hiç dokunmayan HTTP testleri için).
 */
export function testConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DB_HOST: '127.0.0.1',
    DB_USER: 'root',
    DB_NAME: 'unused',
    METRICS_ENABLED: 'false',
    ...TEST_SECRETS,
    ...overrides,
  });
}

/**
 * `mysql://user:pass@host:port/` → db config parçaları.
 */
export function parseMysqlUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

/**
 * Her test dosyası için izole, rastgele adlı bir veritabanı oluşturur; `drop` ile siler.
 */
export async function createTestDatabase(mysqlUrl) {
  const server = parseMysqlUrl(mysqlUrl);
  const database = `mf_test_${randomBytes(4).toString('hex')}`;
  const admin = await mysql.createConnection(server);
  // DDL'de tanımlayıcılar placeholder alamaz; ad yukarıda rastgele üretiliyor (kullanıcı girdisi değil).
  const createSql = `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`;
  await admin.query(createSql);
  await admin.end();

  return {
    env: {
      DB_HOST: server.host,
      DB_PORT: String(server.port),
      DB_USER: server.user,
      DB_PASSWORD: server.password,
      DB_NAME: database,
    },
    async drop() {
      const conn = await mysql.createConnection(server);
      const dropSql = `DROP DATABASE IF EXISTS \`${database}\``;
      await conn.query(dropSql);
      await conn.end();
    },
  };
}
