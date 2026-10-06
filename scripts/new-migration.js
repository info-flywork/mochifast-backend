import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Sıradaki numarayla boş migration dosyası oluşturur.
 *   npm run migrate:new -- create_users_table
 */
const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error('Kullanım: npm run migrate:new -- <kucuk_harf_alt_cizgi_aciklama>');
  process.exit(1);
}

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const versions = (await readdir(dir))
  .map((f) => /^(\d{4})_/.exec(f)?.[1])
  .filter(Boolean)
  .map(Number);
const next = String((versions.length ? Math.max(...versions) : 0) + 1).padStart(4, '0');
const file = path.join(dir, `${next}_${name}.sql`);

await writeFile(
  file,
  `-- ${next}_${name}\n-- Yalnızca ileri yönlü. Uygulandıktan sonra DÜZENLEMEYİN; yeni migration ekleyin.\n\n`,
  { flag: 'wx' },
);
console.log(`Oluşturuldu: migrations/${path.basename(file)}`);
