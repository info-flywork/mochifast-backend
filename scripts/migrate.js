import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index.js';
import { migrate } from '../src/infra/migrator.js';

/**
 * Kullanım:
 *   npm run migrate          bekleyen migration'ları uygular
 *   npm run migrate:status   uygulanmış/bekleyen listesi
 *   npm run migrate:dry      ne uygulanacağını gösterir, uygulamaz
 */
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || args.has('--status');
const dir = fileURLToPath(new URL('../migrations/', import.meta.url));

const config = loadConfig();

try {
  const result = await migrate({
    dbConfig: config.db,
    dir,
    dryRun,
    logger: { info: (obj) => console.log(`✔ ${JSON.stringify(obj)}`) },
  });
  console.log(`Uygulanmış: ${result.applied.length} · Bekleyen: ${result.pending.length}`);
  for (const m of result.pending) {
    console.log(`  ${dryRun ? '•' : '✔'} ${m.file}${dryRun ? ' (uygulanmadı)' : ''}`);
  }
  if (!dryRun) console.log(`Bu çalıştırmada uygulanan: ${result.ran.length}`);
} catch (err) {
  console.error(`✖ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
