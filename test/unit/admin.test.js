import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/infra/password.js';
import { base32Decode, base32Encode, totpAt, verifyTotp } from '../../src/infra/totp.js';
import { buildAllowlist, createAdminAuth, ipAllowed } from '../../src/modules/admin/admin.auth.js';
import { rateKeyForIp } from '../../src/shared/ip.js';
import { can, maskEmail, maskName } from '../../src/modules/admin/admin.permissions.js';

// RFC 6238 Ek B: ASCII "12345678901234567890" (SHA1)
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('test vektörleri (6 hane)', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
    expect(totpAt(RFC_SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(RFC_SECRET, Math.floor(1234567890 / 30))).toBe('005924');
  });

  it('±1 adım kabul; aynı adım tekrar kabul edilmez; biçim hatası reddedilir', () => {
    const nowMs = 1_234_567_890_000;
    const step = Math.floor(nowMs / 30_000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), { nowMs })).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), { nowMs })).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 2), { nowMs })).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), { nowMs, lastStep: step })).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', { nowMs })).toBeNull();
  });
});

describe('şifre (argon2id)', () => {
  it('PHC biçimi; doğru şifre geçer, yanlış ve bozuk hash geçmez', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('yönetici yetkileri ve maskeleme', () => {
  it('roller', () => {
    expect(can('owner', 'admins.manage')).toBe(true);
    expect(can('editor', 'catalog.write')).toBe(true);
    expect(can('editor', 'users.read')).toBe(false);
    expect(can('support', 'users.act')).toBe(true);
    expect(can('analyst', 'reports.read')).toBe(true);
    expect(can('analyst', 'catalog.read')).toBe(false);
  });

  it('PII maskeleme', () => {
    expect(maskEmail('ahmet.yilmaz@gmail.com')).toBe('a***@g***.com');
    expect(maskEmail('x@privaterelay.appleid.com')).toBe('x***@p***.com');
    expect(maskEmail(null)).toBeNull();
    expect(maskName('Ayşe Yılmaz')).toBe('A*** Y***');
  });

  it('IP allowlist: adres, CIDR, IPv4-mapped IPv6; boş liste kısıtsız', () => {
    const list = buildAllowlist(['203.0.113.7', '10.0.0.0/8', '2001:db8::/32']);
    expect(ipAllowed(list, '203.0.113.7')).toBe(true);
    expect(ipAllowed(list, '::ffff:10.20.30.40')).toBe(true);
    expect(ipAllowed(list, '2001:db8::1')).toBe(true);
    expect(ipAllowed(list, '198.51.100.1')).toBe(false);
    expect(ipAllowed(buildAllowlist([]), '198.51.100.1')).toBe(true);
  });

  it('üretimde allowlist boşsa admin API kapalı (ADMIN_ALLOW_ANY_IP ile açılır)', async () => {
    const make = (admin) =>
      createAdminAuth({
        db: null,
        cache: null,
        tokens: null,
        crypto: null,
        config: { isProduction: true, admin },
      });
    const request = { ip: '203.0.113.9', headers: {} };
    await expect(
      make({ ipAllowlist: [], allowAnyIp: false }).guard(null)(request),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'admin_disabled' },
    });
    await expect(
      make({ ipAllowlist: [], allowAnyIp: true }).guard(null)(request),
    ).resolves.toBeUndefined();
    await expect(
      make({ ipAllowlist: ['10.0.0.0/8'], allowAnyIp: false }).guard(null)(request),
    ).rejects.toMatchObject({ details: { reason: 'ip_not_allowed' } });
  });
});

describe('rate limit anahtarı', () => {
  it('IPv6 /64 ağına indirgenir; IPv4 ve IPv4-mapped olduğu gibi', () => {
    expect(rateKeyForIp('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd:12::/64');
    expect(rateKeyForIp('2001:db8:abcd:12::99')).toBe('2001:db8:abcd:12::/64');
    expect(rateKeyForIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateKeyForIp('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(rateKeyForIp('198.51.100.7')).toBe('198.51.100.7');
    expect(rateKeyForIp(undefined)).toBe('unknown');
  });
});
