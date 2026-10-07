import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Yönetici şifreleri: argon2id (06 §5: m=19456 KiB, t=2, p=1), PHC biçiminde saklanır.
 * Node'un yerleşik `crypto.argon2`'si kullanılır (Node ≥ 24.7; ek bağımlılık yok).
 */
const argon2Async = promisify(argon2);
const PARAMS = Object.freeze({ memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 });

const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');

async function derive(password, salt, { memory, passes, parallelism, tagLength }) {
  return argon2Async('argon2id', {
    message: Buffer.from(String(password), 'utf8'),
    nonce: salt,
    memory,
    passes,
    parallelism,
    tagLength,
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, phc) {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
    phc ?? '',
  );
  if (!m) return false;
  const expected = Buffer.from(m[5], 'base64');
  const actual = await derive(password, Buffer.from(m[4], 'base64'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Bilinmeyen e-postada da aynı süre harcanır (kullanıcı varlığı zamanlamadan sızmaz). */
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, dummyHash);
}

/** Okunabilir, güçlü geçici şifre (ilk kurulum ve sıfırlama). */
export function generatePassword() {
  return randomBytes(18).toString('base64url');
}
