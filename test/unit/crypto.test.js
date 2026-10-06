import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFieldCrypto } from '../../src/infra/crypto.js';

const key = () => randomBytes(32).toString('base64');

describe('alan şifreleme (AES-256-GCM)', () => {
  it('şifreler ve çözer; biçim kid|iv|tag|ciphertext', () => {
    const crypto = createFieldCrypto({ keys: { 1: key() }, activeKid: 1 });
    const enc = crypto.encrypt('gizli not ğüşçö', 'meals.notes:u1');
    expect(enc[0]).toBe(1);
    expect(enc.length).toBe(1 + 12 + 16 + Buffer.byteLength('gizli not ğüşçö'));
    expect(crypto.decrypt(enc, 'meals.notes:u1')).toBe('gizli not ğüşçö');
  });

  it('aynı metin her seferinde farklı şifrelenir (rastgele IV)', () => {
    const crypto = createFieldCrypto({ keys: { 1: key() }, activeKid: 1 });
    expect(crypto.encrypt('x').equals(crypto.encrypt('x'))).toBe(false);
  });

  it('farklı bağlam (AAD) ya da değiştirilmiş veri çözülemez', () => {
    const crypto = createFieldCrypto({ keys: { 1: key() }, activeKid: 1 });
    const enc = crypto.encrypt('token', 'auth:u1');
    expect(() => crypto.decrypt(enc, 'auth:u2')).toThrow();
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => crypto.decrypt(tampered, 'auth:u1')).toThrow();
  });

  it('rotasyon: eski anahtarla şifrelenmiş değer yeni aktif anahtarla da okunur', () => {
    const k1 = key();
    const old = createFieldCrypto({ keys: { 1: k1 }, activeKid: 1 });
    const enc = old.encrypt('eski');
    const rotated = createFieldCrypto({ keys: { 1: k1, 2: key() }, activeKid: 2 });
    expect(rotated.decrypt(enc)).toBe('eski');
    expect(rotated.needsReencrypt(enc)).toBe(true);
    expect(rotated.encrypt('yeni')[0]).toBe(2);
  });

  it('hatalı anahtar yapılandırmasını reddeder', () => {
    expect(() => createFieldCrypto({ keys: { 1: 'kisa' }, activeKid: 1 })).toThrow(/32 bayt/);
    expect(() => createFieldCrypto({ keys: { 1: key() }, activeKid: 2 })).toThrow(/Aktif/);
    expect(() => createFieldCrypto({ keys: { 0: key() }, activeKid: 0 })).toThrow(/1–255/);
  });
});
