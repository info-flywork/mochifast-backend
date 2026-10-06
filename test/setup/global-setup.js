import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Test altyapısını test dosyalarına `inject('mysqlUrl')` ile verir.
 * Adres TEST_MYSQL_URL'den gelir: önce ortam değişkeni, yoksa proje kökündeki `.env`.
 * (`.env`'in geri kalanı testlere YÜKLENMEZ; testler kendi konfigürasyonunu kurar.)
 * Verilmezse MySQL isteyen testler atlanır; CI'da (CI=true) eksik MySQL HATADIR.
 */
export default function setup(project) {
  const mysqlUrl = process.env.TEST_MYSQL_URL || fromDotEnv('TEST_MYSQL_URL');

  if (process.env.CI === 'true' && !mysqlUrl) {
    throw new Error('CI ortamında MySQL zorunlu (TEST_MYSQL_URL).');
  }
  if (!mysqlUrl) {
    process.stdout.write('[test] TEST_MYSQL_URL yok → MySQL isteyen testler atlanacak\n');
  }

  project.provide('mysqlUrl', mysqlUrl);
}

function fromDotEnv(key) {
  try {
    const file = new URL('../../.env', import.meta.url);
    return parseEnv(readFileSync(file, 'utf8'))[key] || null;
  } catch {
    return null;
  }
}
