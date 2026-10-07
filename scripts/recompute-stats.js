import '../src/config/env-file.js';
import { loadConfig } from '../src/config/index.js';
import { createDatabase } from '../src/infra/db.js';
import { createStatsService } from '../src/modules/stats/stats.service.js';
import { fromBin } from '../src/shared/ids.js';

/**
 * Türetilmiş verileri (günlük özetler, seri, sayaçlar, XP) ham tablolardan baştan üretir.
 * İdempotent; kural değişikliğinden ya da veri düzeltmesinden sonra çalıştırılır (05 §14).
 *   npm run stats:recompute                 oruç kaydı olan tüm kullanıcılar
 *   npm run stats:recompute -- <userId>     tek kullanıcı
 */
const db = createDatabase(loadConfig().db);
const stats = createStatsService({ db });
try {
  const only = process.argv[2];
  const ids = only
    ? [only]
    : (await db.many('SELECT DISTINCT user_id FROM fasting_sessions')).map((r) =>
        fromBin(r.user_id),
      );
  let failed = 0;
  for (const id of ids) {
    try {
      await stats.recompute(id);
    } catch (err) {
      failed += 1;
      console.error(`✖ ${id}: ${err.message}`);
    }
  }
  console.log(`✔ yeniden hesaplandı: ${ids.length - failed}/${ids.length}`);
  if (failed > 0) process.exitCode = 1;
} catch (err) {
  console.error('✖ yeniden hesaplama başarısız:', err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
