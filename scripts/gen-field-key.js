import { randomBytes } from 'node:crypto';

/**
 * Yeni alan şifreleme anahtarı (AES-256, 32 bayt) üretir.
 *   npm run keys:field                     → ilk anahtar (kid 1)
 *   npm run keys:field -- '<mevcut FIELD_ENCRYPTION_KEYS_JSON>'   → sıradaki kid ile ekler
 *
 * Rotasyonda eski anahtarlar SİLİNMEZ (eski kayıtlar onlarla çözülür); yalnızca aktif kid değişir.
 */
const existing = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const kid = Math.max(0, ...Object.keys(existing).map(Number)) + 1;
if (kid > 255) throw new Error('kid 255 sınırına ulaşıldı');
const keys = { ...existing, [kid]: randomBytes(32).toString('base64') };

console.log(`FIELD_ENCRYPTION_KEYS_JSON='${JSON.stringify(keys)}'`);
console.log(`FIELD_ENCRYPTION_ACTIVE_KID=${kid}`);
