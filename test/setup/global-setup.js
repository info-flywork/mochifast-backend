/**
 * Test altyapısını test dosyalarına `inject('mysqlUrl' | 'redisUrl')` ile verir.
 * Adresler ortam değişkenlerinden gelir: TEST_MYSQL_URL / TEST_REDIS_URL
 * (yerel kurulum ya da CI servisleri). Verilmeyen altyapıyı isteyen testler atlanır;
 * CI'da (CI=true) eksik altyapı HATADIR.
 */
export default function setup(project) {
  const mysqlUrl = process.env.TEST_MYSQL_URL || null;
  const redisUrl = process.env.TEST_REDIS_URL || null;

  if (process.env.CI === 'true' && (!mysqlUrl || !redisUrl)) {
    throw new Error('CI ortamında MySQL ve Redis zorunlu (TEST_MYSQL_URL / TEST_REDIS_URL).');
  }
  if (!mysqlUrl || !redisUrl) {
    const missing = [!mysqlUrl && 'MySQL', !redisUrl && 'Redis'].filter(Boolean).join(', ');
    process.stdout.write(`[test] Eksik altyapı → atlanacak testler: ${missing}\n`);
  }

  project.provide('mysqlUrl', mysqlUrl);
  project.provide('redisUrl', redisUrl);
}
