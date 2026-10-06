import '../src/config/env-file.js';
import { loadConfig } from '../src/config/index.js';
import { createDatabase } from '../src/infra/db.js';
import { loadCatalogSeeds, seedCatalog } from '../src/modules/catalog/catalog.seeder.js';

/**
 * Katalog seed'leri (idempotent). Deploy'da migration'dan sonra çalışır.
 *   npm run seed                     planlar, etiketler, eksik app_config anahtarları
 *   npm run seed -- --overwrite-config   app_config değerlerini de seed'dekiyle değiştirir
 */
const db = createDatabase(loadConfig().db);
try {
  const stats = await seedCatalog(db, await loadCatalogSeeds(), {
    overwriteConfig: process.argv.includes('--overwrite-config'),
  });
  console.log(`✔ seed: ${JSON.stringify(stats)}`);
} catch (err) {
  console.error('✖ seed başarısız:', err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
