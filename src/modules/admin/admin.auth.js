import { BlockList, isIPv4 } from 'node:net';
import {
  hashPassword,
  burnPasswordCheck,
  generatePassword,
  verifyPassword,
} from '../../infra/password.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../infra/totp.js';
import { AppError } from '../../shared/errors.js';
import { rateKeyForIp } from '../../shared/ip.js';
import { newId } from '../../shared/ids.js';
import { createWindowLimiter } from '../../shared/window-limiter.js';
import { writeAudit } from '../audit/audit.repository.js';
import { ADMIN_ROLES, can } from './admin.permissions.js';
import * as repo from './admin.repository.js';

/** 5 hatalı girişte 15 dk kilit (06 §12). */
export const LOCK_AFTER_FAILURES = 5;
export const LOCK_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 12;
const ADMIN_CACHE_TTL_SEC = 30;

const totpContext = (adminId) => `admin_users.totp_secret:${adminId}`;
export const adminCacheKey = (adminId) => `admin:${adminId}`;

/** IPv4 / IPv6 adres ve CIDR listesi → BlockList; boşsa null (kısıt yok). */
export function buildAllowlist(entries) {
  if (!entries?.length) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split('/');
    const type = isIPv4(address) ? 'ipv4' : 'ipv6';
    if (prefix) list.addSubnet(address, Number(prefix), type);
    else list.addAddress(address, type);
  }
  return list;
}

export function ipAllowed(list, ip) {
  if (!list) return true;
  const plain = ip?.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!plain) return false;
  return list.check(plain, isIPv4(plain) ? 'ipv4' : 'ipv6');
}

export function adminDto(a) {
  return {
    id: a.id,
    email: a.email,
    role: a.role,
    isActive: a.isActive,
    mustChangePassword: a.mustChangePassword,
    lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

function weakPassword(path) {
  return new AppError('VALIDATION_FAILED', {
    details: { fields: [{ path, message: `must be at least ${MIN_PASSWORD_LENGTH} characters` }] },
  });
}

/**
 * Yönetici kimlik doğrulama ve hesap yönetimi. Giriş: e-posta + şifre + TOTP; oturum 1 saatlik
 * JWT (`aud = mochifast-admin`), yenileme yok.
 */
export function createAdminAuth({ db, cache, tokens, crypto, config, logger }) {
  const allowlist = buildAllowlist(config.admin.ipAllowlist);
  // Üretimde allowlist boşsa admin API kapalı (06 §12); bilinçli açmak: ADMIN_ALLOW_ANY_IP=true.
  const disabled = config.isProduction && !allowlist && !config.admin.allowAnyIp;
  if (disabled) logger?.warn('ADMIN_IP_ALLOWLIST boş: yönetici API kapalı (ADMIN_ALLOW_ANY_IP)');
  else if (!allowlist) logger?.warn("ADMIN_IP_ALLOWLIST boş: yönetici API her IP'den erişilebilir");
  const loginLimiter = createWindowLimiter({ max: 20, windowMs: 15 * 60_000 });

  function audit(meta, action, adminId, extra = {}) {
    return writeAudit(db, {
      actorType: 'admin',
      actorId: adminId ?? null,
      action,
      entityType: extra.entityType ?? null,
      entityId: extra.entityId ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      metadata: extra.metadata ?? null,
    });
  }

  async function newMfa(adminId, email) {
    const secret = generateTotpSecret();
    return {
      secret,
      enc: crypto.encrypt(secret, totpContext(adminId)),
      setup: { secret, otpauthUrl: otpauthUrl(secret, email) },
    };
  }

  const service = {
    audit,

    /**
     * preHandler fabrikası: IP kısıtı + token + izin.
     * - `null`  : yalnızca IP (giriş)
     * - `'self'`: oturumdaki yönetici, geçici şifre olsa da (me, şifre, çıkış)
     * - `'any'` : her rol; diğerleri `PERMISSIONS` anahtarı
     */
    guard(permission) {
      return async function requireAdmin(request) {
        if (disabled) throw new AppError('FORBIDDEN', { details: { reason: 'admin_disabled' } });
        if (!ipAllowed(allowlist, request.ip)) {
          throw new AppError('FORBIDDEN', { details: { reason: 'ip_not_allowed' } });
        }
        if (permission === null) return;
        const header = request.headers.authorization;
        const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
        if (!match) throw new AppError('UNAUTHENTICATED', { message: 'Bearer token yok' });
        const { adminId, issuedAt } = await tokens.verifyAdmin(match[1]);
        const admin = await cache.getOrSet(
          adminCacheKey(adminId),
          ADMIN_CACHE_TTL_SEC,
          async () => {
            const a = await repo.findById(db, adminId);
            return a
              ? {
                  id: a.id,
                  email: a.email,
                  role: a.role,
                  isActive: a.isActive,
                  mustChangePassword: a.mustChangePassword,
                  // JWT iat saniye hassasiyetinde: karşılaştırma saniyeye yuvarlanır.
                  validAfterSec: a.tokensValidAfter
                    ? Math.floor(a.tokensValidAfter.getTime() / 1000)
                    : 0,
                }
              : null;
          },
        );
        if (!admin?.isActive) throw new AppError('UNAUTHENTICATED', { message: 'yönetici pasif' });
        if (issuedAt.getTime() / 1000 < admin.validAfterSec) {
          throw new AppError('UNAUTHENTICATED', { message: 'oturum sonlandırılmış' });
        }
        if (permission !== 'self') {
          if (admin.mustChangePassword) {
            throw new AppError('FORBIDDEN', { details: { reason: 'password_change_required' } });
          }
          if (permission !== 'any' && !can(admin.role, permission)) throw new AppError('FORBIDDEN');
        }
        request.admin = admin;
      };
    },

    async login({ email, password, totp }, meta) {
      const limit = loginLimiter.hit(rateKeyForIp(meta.ip));
      if (!limit.allowed) {
        throw new AppError('RATE_LIMITED', {
          details: { retryAfterSec: limit.retryAfterSec },
          headers: { 'retry-after': String(limit.retryAfterSec) },
        });
      }
      const invalid = () =>
        new AppError('UNAUTHENTICATED', { message: 'e-posta, şifre ya da kod hatalı' });

      const outcome = await db.withTransaction(async (conn) => {
        const admin = await repo.findByEmail(db, email, conn);
        if (!admin || !admin.isActive) {
          await burnPasswordCheck(password);
          return { error: invalid(), reason: 'unknown_or_inactive' };
        }
        // Kilitli hesap ayrı hata döndürmez ve aynı süreyi harcar: hesap varlığı sızmaz.
        if (admin.lockedUntil && admin.lockedUntil > new Date()) {
          await burnPasswordCheck(password);
          return { admin, error: invalid(), reason: 'locked' };
        }
        const passwordOk = await verifyPassword(password, admin.passwordHash);
        const step = passwordOk
          ? verifyTotp(crypto.decrypt(admin.totpSecretEnc, totpContext(admin.id)), totp, {
              lastStep: admin.totpLastStep,
            })
          : null;
        if (step === null) {
          const failures = admin.failedAttempts + 1;
          const lock = failures >= LOCK_AFTER_FAILURES;
          await repo.update(
            db,
            admin.id,
            {
              failedAttempts: lock ? 0 : failures,
              lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : undefined,
            },
            conn,
          );
          return {
            admin,
            error: invalid(),
            reason: passwordOk ? 'totp' : 'password',
            locked: lock,
          };
        }
        await repo.update(
          db,
          admin.id,
          { failedAttempts: 0, lockedUntil: null, totpLastStep: step, lastLoginAt: new Date() },
          conn,
        );
        return { admin };
      });

      if (outcome.error) {
        await audit(meta, 'admin.login_failed', outcome.admin?.id, {
          metadata: { reason: outcome.reason, locked: outcome.locked ?? false },
        });
        throw outcome.error;
      }
      const { token, expiresIn } = await tokens.signAdmin({ adminId: outcome.admin.id });
      await audit(meta, 'admin.login', outcome.admin.id);
      return { token, expiresIn, admin: adminDto({ ...outcome.admin, lastLoginAt: new Date() }) };
    },

    async me(adminId) {
      const a = await repo.findById(db, adminId);
      if (!a) throw new AppError('NOT_FOUND');
      return { admin: adminDto(a) };
    },

    /** Şifre değişir, eski token'lar iptal olur; yanıtta yeni token döner. */
    async changePassword(adminId, { currentPassword, newPassword }, meta) {
      const limit = loginLimiter.hit(`pw:${adminId}`);
      if (!limit.allowed) {
        throw new AppError('RATE_LIMITED', { details: { retryAfterSec: limit.retryAfterSec } });
      }
      const a = await repo.findById(db, adminId);
      if (!a || !(await verifyPassword(currentPassword, a.passwordHash))) {
        throw new AppError('UNAUTHENTICATED', { message: 'mevcut şifre hatalı' });
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) throw weakPassword('newPassword');
      if (newPassword === currentPassword) {
        throw new AppError('VALIDATION_FAILED', {
          details: { fields: [{ path: 'newPassword', message: 'must differ from current' }] },
        });
      }
      await repo.update(db, adminId, {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        tokensValidAfter: new Date(),
      });
      await cache.del(adminCacheKey(adminId));
      await audit(meta, 'admin.password_changed', adminId);
      return tokens.signAdmin({ adminId });
    },

    /** Çıkış: bu yöneticinin bu ana kadar verilmiş tüm token'ları geçersiz. */
    async logout(adminId, meta) {
      await repo.update(db, adminId, { tokensValidAfter: new Date() });
      await cache.del(adminCacheKey(adminId));
      await audit(meta, 'admin.logout', adminId);
      return {};
    },

    // ── Yönetici hesapları (owner) ──────────────────────────────────────
    async listAdmins() {
      return { items: (await repo.list(db)).map(adminDto) };
    },

    /**
     * Yeni yönetici: geçici şifre ve TOTP kurulumu YALNIZCA bu yanıtta döner.
     * Script (`npm run admin:create`) aynı fonksiyonu kullanır.
     */
    async createAdmin({ email, role }, meta, actorId = null) {
      if (!ADMIN_ROLES.includes(role)) throw new AppError('VALIDATION_FAILED');
      if (await repo.findByEmail(db, email)) {
        throw new AppError('CONFLICT', { details: { reason: 'email_exists' } });
      }
      const id = newId();
      const password = generatePassword();
      const mfa = await newMfa(id, email.trim().toLowerCase());
      await repo.insert(db, {
        id,
        email,
        passwordHash: await hashPassword(password),
        role,
        totpSecretEnc: mfa.enc,
      });
      await audit(meta, 'admin.admin_created', actorId, {
        entityType: 'admin_user',
        entityId: id,
        metadata: { role },
      });
      return { admin: adminDto(await repo.findById(db, id)), password, totp: mfa.setup };
    },

    async updateAdmin(id, { role, isActive }, meta, actorId) {
      const a = await repo.findById(db, id);
      if (!a) throw new AppError('NOT_FOUND');
      if (id === actorId && (isActive === false || (role && role !== 'owner'))) {
        throw new AppError('CONFLICT', { details: { reason: 'cannot_demote_self' } });
      }
      await repo.update(db, id, {
        role,
        isActive,
        // Pasifleştirme ve rol değişikliği açık oturumları kapatır.
        tokensValidAfter: isActive === false || role ? new Date() : undefined,
      });
      await cache.del(adminCacheKey(id));
      await audit(meta, 'admin.admin_updated', actorId, {
        entityType: 'admin_user',
        entityId: id,
        metadata: { role, isActive },
      });
      return { admin: adminDto(await repo.findById(db, id)) };
    },

    /** Telefon kaybı vb.: yeni TOTP sırrı + geçici şifre; kilit kalkar. */
    async resetCredentials(id, meta, actorId) {
      const a = await repo.findById(db, id);
      if (!a) throw new AppError('NOT_FOUND');
      const password = generatePassword();
      const mfa = await newMfa(id, a.email);
      await repo.update(db, id, {
        passwordHash: await hashPassword(password),
        totpSecretEnc: mfa.enc,
        totpLastStep: null,
        failedAttempts: 0,
        lockedUntil: null,
        mustChangePassword: true,
        tokensValidAfter: new Date(),
      });
      await cache.del(adminCacheKey(id));
      await audit(meta, 'admin.credentials_reset', actorId, {
        entityType: 'admin_user',
        entityId: id,
      });
      return { admin: adminDto(await repo.findById(db, id)), password, totp: mfa.setup };
    },
  };
  return service;
}
