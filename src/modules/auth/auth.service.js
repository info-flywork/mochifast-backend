import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createCache } from '../../infra/cache.js';
import { hashRefreshToken, newRefreshToken } from '../../infra/tokens.js';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../../config/constants.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { rateKeyForIp } from '../../shared/ip.js';
import { isValidTimezone } from '../../shared/time.js';
import { createWindowLimiter } from '../../shared/window-limiter.js';
import { sessionCachePrefix } from '../../plugins/auth.js';
import { writeAudit } from '../audit/audit.repository.js';
import * as accountRepo from '../account/account.repository.js';
import { GUEST_MERGE_STEPS } from './guest-merge.js';
import * as repo from './auth.repository.js';

const ER_DUP_ENTRY = 1062;
/** Aynı refresh token'la paralel gelen isteklere aynı yeni çift bu süre boyunca döner. */
const REFRESH_GRACE_SEC = 10;

/** Hesap birleştirmede kapatılan misafirin silinmesine kalan süre (05 §11). */
const GUEST_RETIRED_DAYS = 30;

/**
 * Kimlik doğrulama iş kuralları (docs/backend/04-api.md §1, 06-guvenlik.md §2, 05-is-kurallari.md §11).
 *
 * `meta`: { ip, userAgent, locale, timezone, platform } — istek bağlamından.
 */
export function createAuthService({ db, cache, tokens, firebase, config, logger, entitlements }) {
  const withPremium = async (dto) => ({
    ...dto,
    isPremium: (await entitlements?.isPremium(dto.id)) ?? false,
  });
  const refreshTtlDays = config.auth.refreshTtlDays;
  const refreshAbsoluteDays = config.auth.refreshAbsoluteDays;
  // Verilen çift yalnızca 10 sn bellekte tutulur (ADR 0005: API tek process).
  const refreshGrace = createCache({ maxEntries: 10_000 });
  const installLimiter = createWindowLimiter({ max: 5, windowMs: 3_600_000 });
  // Yeni misafir: IP başına saatte 10 — hangi uçtan gelirse gelsin (/auth/guest ya da
  // /auth/register provider=guest). Her misafir ücretsiz AI kotası taşır (bütçe tüketme saldırısı).
  const guestCreateLimiter = createWindowLimiter({ max: 10, windowMs: 3_600_000 });
  // Yenileme: oturum ailesi başına saatte 30 (06 §7). Access token 15 dk; meşru istemci saatte
  // ~4 yeniler, çalınmış refresh token'la yoğun deneme burada durur.
  const refreshLimiter = createWindowLimiter({ max: 30, windowMs: 3_600_000 });

  async function openSession(conn, { userId, deviceId, familyId, meta }) {
    const refreshToken = newRefreshToken();
    const sessionId = newId();
    await repo.insertSession(db, conn, {
      id: sessionId,
      userId,
      deviceId,
      familyId: familyId ?? newId(),
      tokenHash: hashRefreshToken(refreshToken),
      ttlDays: refreshTtlDays,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const access = await tokens.signAccess({ userId, sessionId });
    return { accessToken: access.token, refreshToken, expiresIn: access.expiresIn };
  }

  function audit(conn, meta, action, userId, metadata) {
    return writeAudit(
      db,
      {
        actorType: 'user',
        actorId: userId,
        action,
        entityType: 'user',
        entityId: userId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata,
      },
      conn,
    );
  }

  /** Eşzamanlı ilk kayıt yarışında (aynı kimlik iki kez eklenmeye çalışılırsa) bir kez yeniden dener. */
  async function withDuplicateRetry(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err?.errno !== ER_DUP_ENTRY) throw err;
      return fn();
    }
  }

  function localeOf(input, meta) {
    const value = input.locale ?? meta.locale;
    return SUPPORTED_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
  }

  function timezoneOf(input, meta) {
    const value = input.timezone ?? meta.timezone;
    return isValidTimezone(value) ? value : 'UTC';
  }

  async function upsertDevice(conn, userId, input, meta) {
    const platform = input.platform ?? meta.platform;
    if (!input.installId || !platform) return null;
    return repo.upsertDevice(db, conn, {
      userId,
      installId: input.installId,
      platform,
      appVersion: input.appVersion ?? meta.appVersion,
      osVersion: input.osVersion,
      deviceModel: input.deviceModel,
      locale: localeOf(input, meta),
      timezone: timezoneOf(input, meta),
    });
  }

  /** Misafir/terk edilen hesabı kapatır: installId ile girilemez, oturumları iptal, 30 gün sonra silinir. */
  async function retireGuest(conn, guestId) {
    await repo.setUserStatus(db, conn, guestId, 'pending_deletion');
    await accountRepo.insertDeletionRequest(db, conn, {
      userId: guestId,
      source: 'guest_retired',
      scheduledFor: new Date(Date.now() + GUEST_RETIRED_DAYS * 86_400_000),
    });
    await repo.deleteGuestIdentities(db, conn, guestId);
    await repo.revokeUserSessions(db, conn, guestId, 'account_switched');
  }

  /**
   * Var olan kimliğin hesabına giriş izni. Kullanıcının kendi silme talebi beklemedeyse
   * 409 ACCOUNT_PENDING_DELETION; `restoreAccount: true` ile talep iptal edilir, hesap açılır.
   */
  async function admitExisting(conn, existing, input, meta) {
    if (existing.status === 'pending_deletion') {
      const pending = await accountRepo.scheduledDeletion(db, existing.userId, conn);
      if (pending?.source === 'user') {
        if (input.restoreAccount !== true) {
          throw new AppError('ACCOUNT_PENDING_DELETION', {
            details: { scheduledFor: pending.scheduledFor.toISOString(), options: ['restore'] },
          });
        }
        await accountRepo.cancelDeletion(db, conn, existing.userId);
        await repo.setUserStatus(db, conn, existing.userId, 'active');
        await audit(conn, meta, 'account.restored', existing.userId, {});
        return;
      }
    }
    assertUsable(existing.status);
  }

  const service = {
    /**
     * Misafir: aynı installId → aynı kullanıcıya yeni oturum; yoksa yeni misafir kullanıcı.
     * @returns { created, token, user }
     */
    async guest(input, meta) {
      const limit = installLimiter.hit(input.installId);
      if (!limit.allowed) {
        throw new AppError('RATE_LIMITED', {
          details: { retryAfterSec: limit.retryAfterSec },
          headers: { 'retry-after': String(limit.retryAfterSec) },
        });
      }

      return withDuplicateRetry(() =>
        db.withTransaction(async (conn) => {
          const existing = await repo.findIdentity(db, conn, 'guest', input.installId);
          let userId;
          let guestSecret = null;
          if (existing) {
            if (existing.secretHash) {
              if (!guestSecretMatches(input.guestSecret, existing.secretHash)) {
                throw new AppError('UNAUTHENTICATED', {
                  message: 'misafir sırrı geçersiz',
                  details: { reason: 'guest_secret_invalid' },
                });
              }
            } else {
              // Eski misafir: bu girişte sır verilir, sonraki girişlerde istenir.
              guestSecret = newGuestSecret();
              await repo.setIdentitySecret(db, conn, existing.id, hashGuestSecret(guestSecret));
            }
            await admitExisting(conn, existing, input, meta);
            userId = existing.userId;
            await repo.touchIdentity(db, conn, existing.id);
          } else {
            const created = guestCreateLimiter.hit(rateKeyForIp(meta.ip));
            if (!created.allowed) {
              throw new AppError('RATE_LIMITED', {
                details: { retryAfterSec: created.retryAfterSec },
                headers: { 'retry-after': String(created.retryAfterSec) },
              });
            }
            userId = newId();
            await repo.createUser(db, conn, {
              id: userId,
              isGuest: true,
              locale: localeOf(input, meta),
              timezone: timezoneOf(input, meta),
            });
            guestSecret = newGuestSecret();
            await repo.createIdentity(db, conn, {
              userId,
              provider: 'guest',
              subject: input.installId,
              secretHash: hashGuestSecret(guestSecret),
            });
          }
          const deviceId = await upsertDevice(conn, userId, input, meta);
          const token = await openSession(conn, { userId, deviceId, meta });
          await audit(conn, meta, existing ? 'auth.login' : 'auth.guest_created', userId, {
            provider: 'guest',
          });
          return {
            created: !existing,
            token,
            // Yalnızca yeni verildiğinde döner; istemci güvenli depoda saklar.
            guestSecret,
            user: await withPremium(toUserDto(await repo.getUser(db, conn, userId))),
          };
        }),
      );
    },

    /**
     * Firebase (Apple/Google) ile giriş, kayıt ya da misafir yükseltme.
     * @param currentUser geçerli misafir oturumu varsa request.user
     * @returns { outcome, token, user } — outcome: created | login | upgraded | switched | merged
     */
    async register(input, meta, currentUser) {
      if (input.provider === 'guest') {
        if (!input.deviceId) throw validation('deviceId', 'required for guest');
        const result = await service.guest({ ...input, installId: input.deviceId }, meta);
        return {
          outcome: result.created ? 'created' : 'login',
          token: result.token,
          guestSecret: result.guestSecret,
          user: result.user,
        };
      }
      if (!input.idToken) throw validation('idToken', 'required');

      // Apple/Google girişini istemcideki Firebase yapar; burada Firebase ID token'ı doğrulanır.
      const verified = await firebase.verify(input.idToken);
      // Apple adı yalnızca ilk girişte ve yalnızca istemciye verir; Firebase token'ında olmayabilir.
      const displayName = joinName(input.fullName) ?? verified.name;
      const guestUser = currentUser?.isGuest ? currentUser : null;
      const identity = {
        provider: 'firebase',
        subject: verified.subject,
        signInProvider: verified.signInProvider,
        email: verified.email,
      };

      const result = await withDuplicateRetry(() =>
        db.withTransaction(async (conn) => {
          const existing = await repo.findIdentity(db, conn, identity.provider, identity.subject);
          let userId;
          let outcome;

          if (existing) {
            await admitExisting(conn, existing, input, meta);
            userId = existing.userId;
            outcome = 'login';
            if (guestUser && guestUser.id !== userId) {
              if (input.mergeGuest === undefined) {
                throw new AppError('ACCOUNT_LINK_CONFLICT', {
                  details: { options: ['switch_account', 'merge'] },
                });
              }
              if (input.mergeGuest) {
                for (const step of GUEST_MERGE_STEPS) {
                  await step(conn, { db, fromUserId: guestUser.id, toUserId: userId });
                }
              }
              await retireGuest(conn, guestUser.id);
              outcome = input.mergeGuest ? 'merged' : 'switched';
            }
            await repo.touchIdentity(db, conn, existing.id, identity);
          } else if (guestUser) {
            // Misafir yükseltme: aynı userId, veriler yerinde kalır.
            userId = guestUser.id;
            outcome = 'upgraded';
            await repo.createIdentity(db, conn, { userId, ...identity });
            await repo.upgradeGuest(db, conn, userId, {
              displayName,
              email: verified.email,
              emailVerified: verified.emailVerified,
            });
            await repo.deleteGuestIdentities(db, conn, userId);
            // Misafir token'ları yerine yeni çift verilir.
            await repo.revokeUserSessions(db, conn, userId, 'account_switched');
          } else {
            userId = newId();
            outcome = 'created';
            await repo.createUser(db, conn, {
              id: userId,
              isGuest: false,
              displayName,
              email: verified.email,
              emailVerified: verified.emailVerified,
              locale: localeOf(input, meta),
              timezone: timezoneOf(input, meta),
            });
            await repo.createIdentity(db, conn, { userId, ...identity });
          }

          const deviceId = await upsertDevice(
            conn,
            userId,
            { ...input, installId: input.deviceId },
            meta,
          );
          const token = await openSession(conn, { userId, deviceId, meta });
          await audit(conn, meta, outcome === 'upgraded' ? 'auth.linked' : 'auth.login', userId, {
            provider: identity.signInProvider,
            outcome,
            ...(guestUser && outcome !== 'login' ? { guestUserId: guestUser.id } : {}),
          });
          return {
            outcome,
            token,
            user: await withPremium(toUserDto(await repo.getUser(db, conn, userId))),
          };
        }),
      );

      if (guestUser && result.outcome !== 'login' && result.outcome !== 'created') {
        await cache.delPrefix(sessionCachePrefix(guestUser.id));
      }
      return result;
    },

    /**
     * Refresh token rotasyonu + yeniden kullanım tespiti (docs/backend/06-guvenlik.md §2.2).
     */
    async refresh(refreshToken, meta) {
      const tokenHash = hashRefreshToken(refreshToken);
      const result = await db.withTransaction(async (conn) => {
        const s = await repo.findSessionByHash(db, conn, tokenHash);
        if (!s || !s.live) return { error: 'UNAUTHENTICATED' };

        if (s.revoked) {
          if (s.revokeReason === 'rotated' && s.rotatedRecently) {
            // Paralel istek: ilk isteğin verdiği çifti döndür. Bellekte yoksa (ör. yeniden başlatma)
            // aileyi iptal etmeden reddet; meşru istemciyi kilitlemeyelim.
            const pair = await refreshGrace.get(tokenHash);
            return pair ? { token: pair } : { error: 'UNAUTHENTICATED' };
          }
          if (s.revokeReason === 'rotated' || s.revokeReason === 'reuse_detected') {
            // Kullanılmış token tekrar geldi → çalınmış olabilir: tüm aile iptal.
            await repo.revokeFamily(db, conn, s, 'reuse_detected');
            await audit(conn, meta, 'auth.reuse_detected', s.userId, { familyId: s.familyId });
            return { error: 'REFRESH_REUSED', userId: s.userId };
          }
          return { error: 'UNAUTHENTICATED' };
        }
        if (s.userStatus !== 'active') return { error: 'UNAUTHENTICATED' };
        const limit = refreshLimiter.hit(s.familyId);
        if (!limit.allowed) return { error: 'RATE_LIMITED', retryAfterSec: limit.retryAfterSec };
        // Mutlak ömür (ASVS 3.3.2): yenileme oturumu sonsuza kadar uzamaz.
        if (Date.now() - s.familyStartedAt.getTime() > refreshAbsoluteDays * 86_400_000) {
          await repo.revokeFamily(db, conn, s, 'logout');
          return { error: 'UNAUTHENTICATED' };
        }

        const nextId = newId();
        const nextToken = newRefreshToken();
        await repo.insertSession(db, conn, {
          id: nextId,
          userId: s.userId,
          deviceId: s.deviceId,
          familyId: s.familyId,
          familyStartedAt: s.familyStartedAt,
          tokenHash: hashRefreshToken(nextToken),
          ttlDays: refreshTtlDays,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        await repo.markRotated(db, conn, s.id, nextId);
        const access = await tokens.signAccess({ userId: s.userId, sessionId: nextId });
        const pair = {
          accessToken: access.token,
          refreshToken: nextToken,
          expiresIn: access.expiresIn,
        };
        // Commit'ten ÖNCE yazılır: satır kilidini bekleyen paralel istek commit sonrası bunu görür.
        await refreshGrace.set(tokenHash, pair, REFRESH_GRACE_SEC);
        return { token: pair };
      });

      if (result.error === 'REFRESH_REUSED') {
        await cache.delPrefix(sessionCachePrefix(result.userId));
        logger?.warn(
          { userId: result.userId },
          'refresh token yeniden kullanımı: aile iptal edildi',
        );
      }
      if (result.error === 'RATE_LIMITED') {
        throw new AppError('RATE_LIMITED', {
          details: { retryAfterSec: result.retryAfterSec },
          headers: { 'retry-after': String(result.retryAfterSec) },
        });
      }
      if (result.error) throw new AppError(result.error);
      return result.token;
    },

    /** Mevcut oturum ailesini ya da tüm oturumları kapatır; ilgili push token'ları siler. */
    async logout(user, { allDevices = false }, meta) {
      await db.withTransaction(async (conn) => {
        if (allDevices) {
          await repo.revokeUserSessions(db, conn, user.id, 'logout');
          await repo.clearPushTokens(db, conn, user.id, null);
        } else {
          const s = await repo.findSession(db, conn, user.id, user.sessionId);
          if (s) {
            await repo.revokeFamily(db, conn, { familyId: s.familyId, userId: user.id }, 'logout');
            if (s.deviceId) await repo.clearPushTokens(db, conn, user.id, s.deviceId);
          }
        }
        await audit(conn, meta, 'auth.logout', user.id, { allDevices });
      });
      await cache.delPrefix(sessionCachePrefix(user.id));
    },

    /** Aktif oturumlar; `id` = oturum ailesi (yenilemelerde değişmez). */
    async listSessions(user) {
      const current = await repo.findSession(db, undefined, user.id, user.sessionId);
      const rows = await repo.listActiveSessions(db, user.id);
      return rows.map((r) => ({
        id: r.family_id,
        platform: r.platform ?? null,
        deviceModel: r.device_model ?? null,
        appVersion: r.app_version ?? null,
        signedInAt: r.signed_in_at.toISOString(),
        lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
        current: r.family_id === current?.familyId,
      }));
    },

    async revokeSession(user, familyId, meta) {
      const affected = await db.withTransaction(async (conn) => {
        const n = await repo.revokeFamily(db, conn, { familyId, userId: user.id }, 'logout');
        if (n > 0) await audit(conn, meta, 'auth.session_revoked', user.id, { familyId });
        return n;
      });
      if (affected === 0) throw new AppError('NOT_FOUND');
      await cache.delPrefix(sessionCachePrefix(user.id));
    },
  };
  return service;
}

/** API kullanıcı özeti (docs/backend/04-api.md §1). Premium durumu servis ekler (withPremium). */
export function toUserDto(row) {
  return {
    id: row.id,
    name: row.display_name ?? null,
    email: row.email ?? null,
    isGuest: Boolean(row.is_guest),
    isPremium: false,
    isAnsweredQuestions: row.onboarding_completed_at !== null,
  };
}

/** Misafir sırrı: `gs_` + 256 bit; DB'de SHA-256'sı. */
function newGuestSecret() {
  return `gs_${randomBytes(32).toString('base64url')}`;
}

function hashGuestSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function guestSecretMatches(secret, expectedHash) {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const given = Buffer.from(hashGuestSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function assertUsable(status) {
  if (status === 'banned') throw new AppError('FORBIDDEN');
  if (status !== 'active') throw new AppError('GONE');
}

function joinName(fullName) {
  const name = [fullName?.givenName, fullName?.familyName].filter(Boolean).join(' ').trim();
  return name ? name.slice(0, 60) : null;
}

function validation(path, message) {
  return new AppError('VALIDATION_FAILED', { details: { fields: [{ path, message }] } });
}
