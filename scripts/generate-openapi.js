import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config/index.js';
import { buildApp } from '../src/app.js';

/**
 * Route şemalarından `openapi.json` üretir (altyapıya bağlanmadan). CI artifact'ı olarak saklanır;
 * ileride Dart istemci modelleri buradan üretilebilir.
 */
const config = loadConfig({
  NODE_ENV: 'test',
  DB_HOST: 'unused',
  DB_USER: 'unused',
  DB_NAME: 'unused',
  JWT_PRIVATE_JWK: '{}',
  JWT_PUBLIC_JWKS: '[]',
  FIELD_ENCRYPTION_KEYS_JSON: '{}',
  FIELD_ENCRYPTION_ACTIVE_KID: '1',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? 'https://api.mochifast.app',
});

const unavailable = async () => {
  throw new Error('openapi üretiminde altyapı yok');
};
const app = await buildApp({
  config,
  logger: false,
  deps: {
    db: { ping: unavailable },
    cache: {},
    jobs: {},
  },
});
await app.ready();
const spec = app.swagger();
await writeFile('openapi.json', `${JSON.stringify(spec, null, 2)}\n`);
await app.close();
console.log(`openapi.json yazıldı (${Object.keys(spec.paths ?? {}).length} yol)`);
