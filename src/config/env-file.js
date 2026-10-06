import { fileURLToPath } from 'node:url';

/**
 * Proje kökündeki `.env` dosyasını (varsa) `process.env`'e yükler. Giriş noktalarının İLK
 * import'u olmalıdır. Zaten tanımlı değişkenleri ezmez: komut satırından/PM2'den verilen değer
 * `.env`'dekinden önceliklidir. Dosya yoksa sessizce geçer.
 */
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));

try {
  process.loadEnvFile(envPath);
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
