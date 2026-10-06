import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Alan seviyesinde şifreleme: AES-256-GCM (docs/backend/06-guvenlik.md §6).
 * Biçim: kid (1 bayt) | iv (12) | tag (16) | ciphertext.
 *
 * - Anahtar rotasyonu: yeni anahtar yeni `kid` ile eklenir ve aktif yapılır; eski anahtarlar
 *   okunabilir kalır (eski kayıtlar kendi `kid`'leriyle çözülür).
 * - `context` (AAD): şifreli değeri bulunduğu yere bağlar, ör. "auth_identities.apple:<userId>".
 *   Başka bir satıra/kolona kopyalanan şifreli değer çözülemez.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/**
 * @param options.keys `{ "1": "<base64 32 bayt>", ... }` (FIELD_ENCRYPTION_KEYS_JSON)
 * @param options.activeKid şifrelemede kullanılan anahtar
 */
export function createFieldCrypto({ keys, activeKid }) {
  const keyring = new Map();
  for (const [kid, value] of Object.entries(keys)) {
    const id = Number(kid);
    if (!Number.isInteger(id) || id < 1 || id > 255) {
      throw new Error(`Alan şifreleme anahtar kimliği 1–255 arası tamsayı olmalı: "${kid}"`);
    }
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new Error(`Alan şifreleme anahtarı ${kid} 32 bayt olmalı`);
    keyring.set(id, key);
  }
  if (!keyring.has(activeKid)) {
    throw new Error(`Aktif alan şifreleme anahtarı (${activeKid}) anahtarlar arasında yok`);
  }

  return {
    encrypt(plaintext, context = '') {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', keyring.get(activeKid), iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([activeKid]), iv, cipher.getAuthTag(), body]);
    },

    decrypt(payload, context = '') {
      if (!Buffer.isBuffer(payload) || payload.length < HEADER_BYTES) {
        throw new Error('şifreli değer bozuk');
      }
      const key = keyring.get(payload[0]);
      if (!key) throw new Error(`bilinmeyen alan şifreleme anahtarı: ${payload[0]}`);
      const iv = payload.subarray(1, 1 + IV_BYTES);
      const tag = payload.subarray(1 + IV_BYTES, HEADER_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(payload.subarray(HEADER_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    },

    /** Değer eski bir anahtarla mı şifrelenmiş (re-encrypt işi için)? */
    needsReencrypt(payload) {
      return Buffer.isBuffer(payload) && payload[0] !== activeKid;
    },
  };
}
