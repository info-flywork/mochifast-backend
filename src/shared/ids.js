import { parse, stringify, v7, validate, version } from 'uuid';

/**
 * Birincil anahtarlar UUIDv7'dir: zaman sıralı (B-tree dostu), DB'de BINARY(16), API'de string.
 * (docs/backend/02-mimari.md §3.4)
 */

export function newId() {
  return v7();
}

/**
 * UUID string → BINARY(16) Buffer.
 */
export function toBin(id) {
  return Buffer.from(parse(id));
}

/**
 * BINARY(16) Buffer → UUID string. NULL için null.
 */
export function fromBin(buf) {
  if (!buf) return null;
  return stringify(buf);
}

export function isUuid(value) {
  return typeof value === 'string' && validate(value);
}

/**
 * İstemcinin ürettiği ID'leri kabul etmek için: geçerli UUIDv7 ve zaman bileşeni
 * şimdiye göre makul aralıkta mı? (çevrimdışı kuyruk + yeniden deneme idempotency'si)
 * @param [options.maxSkewMs] geleceğe ve geçmişe izin verilen sapma
 */
export function isAcceptableClientId(value, options = {}) {
  const { maxSkewMs = 7 * 24 * 60 * 60 * 1000, now = Date.now() } = options;
  if (!isUuid(value) || version(value) !== 7) return false;
  return Math.abs(uuidV7Timestamp(value) - now) <= maxSkewMs;
}

/**
 * UUIDv7'nin ilk 48 bitindeki Unix milisaniye zaman damgası.
 */
export function uuidV7Timestamp(id) {
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}
