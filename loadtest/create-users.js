import '../src/config/env-file.js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { createCache } from '../src/infra/cache.js';
import { createFieldCrypto } from '../src/infra/crypto.js';
import { createDatabase } from '../src/infra/db.js';
import { createFirebaseVerifier } from '../src/infra/firebase-auth.js';
import { createJobQueue } from '../src/infra/queue.js';
import { createTokenService } from '../src/infra/tokens.js';
import { createMediaStorage } from '../src/infra/bunny.js';
import { createEntitlements } from '../src/modules/billing/billing.service.js';

/**
 * Yük testi kullanıcıları: N misafir oluşturur, onboarding'i tamamlar, access token'larını
 * `loadtest/users.json`'a yazar (k6 okur). Ağ üzerinden değil uygulama içinden (inject) çalışır:
 * IP rate limit'lerine takılmaz. YALNIZCA STAGING veritabanında çalıştırın.
 *
 *   JWT_ACCESS_TTL_SEC=3600 node loadtest/create-users.js 500
 *
 * Token'lar 1 saat geçerlidir; k6'yı hemen ardından çalıştırın. Temizlik: kullanıcılar
 * `loadtest-` ön ekli kurulumdan gelir; 90 gün sonra misafir saklama işi siler ya da
 * `DELETE FROM users WHERE id IN (...)`.
 */
const count = Number(process.argv[2] ?? 500);
const config = loadConfig();
if (config.env === 'production' && process.env.LOADTEST_ALLOW_PRODUCTION !== '1') {
  console.error('✖ üretimde çalışmaz (LOADTEST_ALLOW_PRODUCTION=1 ile zorlanabilir)');
  process.exit(1);
}
const db = createDatabase(config.db);
const cache = createCache();
const app = await buildApp({
  config,
  logger: false,
  deps: {
    db,
    cache,
    jobs: createJobQueue(db),
    tokens: await createTokenService(config.auth),
    crypto: createFieldCrypto(config.fieldEncryption),
    firebase: createFirebaseVerifier(config.firebase),
    storage: createMediaStorage(config.media),
    entitlements: createEntitlements({ db, cache, config: config.billing }),
  },
});

const ip = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255 || 1}`;
const onboarding = {
  schemaVersion: 1,
  goal: 'loseWeight',
  gender: 'woman',
  weightKg: 74,
  goalWeightKg: 66,
  heightCm: 170,
  age: 31,
  diet: 'everything',
  foodLoves: ['eggs'],
  weightHistory: 'firstTime',
  fastingReason: 'health',
  planCode: '16_8',
  mealWindow: { start: '09:00', end: '17:00' },
  consents: { terms: '2026-10', privacy: '2026-10', healthData: true },
};

const users = [];
try {
  for (let i = 1; i <= count; i += 1) {
    const guest = await app.inject({
      method: 'POST',
      url: '/v1/auth/guest',
      remoteAddress: ip(i),
      payload: {
        installId: randomUUID(),
        platform: 'ios',
        locale: 'tr',
        timezone: 'Europe/Istanbul',
      },
    });
    if (guest.statusCode >= 300) throw new Error(`guest ${guest.statusCode}: ${guest.body}`);
    const token = guest.json().data.token.accessToken;
    const ob = await app.inject({
      method: 'POST',
      url: '/v1/user/onboarding',
      remoteAddress: ip(i),
      headers: { authorization: `Bearer ${token}`, 'x-timezone': 'Europe/Istanbul' },
      payload: onboarding,
    });
    if (ob.statusCode >= 300) throw new Error(`onboarding ${ob.statusCode}: ${ob.body}`);
    // Yarısında aktif oruç olsun (summary'nin ağır yolu).
    if (i % 2 === 0) {
      await app.inject({
        method: 'POST',
        url: '/v1/fasts',
        remoteAddress: ip(i),
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
    }
    users.push({ token });
    if (i % 50 === 0) console.log(`  ${i}/${count}`);
  }
  await writeFile(new URL('./users.json', import.meta.url), JSON.stringify(users));
  console.log(`✔ ${users.length} kullanıcı → loadtest/users.json`);
} catch (err) {
  console.error('✖', err.message);
  process.exitCode = 1;
} finally {
  await app.close();
  await db.close();
}
