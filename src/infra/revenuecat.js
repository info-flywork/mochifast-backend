import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../shared/errors.js';

/**
 * RevenueCat REST (v1) istemcisi (docs/backend/11-abonelik.md). Doğruluk kaynağı RevenueCat'tir:
 * webhook sıra dışı/tekrarlı gelebilir, bu yüzden her olayda abonenin GÜNCEL durumu çekilir.
 */

const API = 'https://api.revenuecat.com/v1';
const TIMEOUT_MS = 8_000;

const STORES = new Set([
  'app_store',
  'play_store',
  'promotional',
  'stripe',
  'amazon',
  'mac_app_store',
  'rc_billing',
]);
const PERIODS = new Set(['trial', 'intro', 'normal', 'promotional', 'prepaid']);
const date = (v) => (v ? new Date(v) : null);

/** Webhook Authorization başlığı (sabit zamanlı karşılaştırma). */
export function webhookAuthorized(header, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(header ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Abone yanıtı → abonelik durumu (bir entitlement için). Entitlement hiç yoksa null.
 * Durum: iade → refunded; süresiz ya da süresi gelmemiş → active (ödeme sorunu varsa
 * billing_issue); ödemesiz ek süre (grace) içinde → in_grace; değilse expired.
 */
export function mapSubscriber(body, entitlement, now = new Date()) {
  const subscriber = body?.subscriber;
  const ent = subscriber?.entitlements?.[entitlement];
  if (!ent) return null;
  const productId = ent.product_identifier ?? null;
  const sub = subscriber.subscriptions?.[productId] ?? null;
  const expiresAt = date(ent.expires_date);
  const graceExpiresAt = date(ent.grace_period_expires_date ?? sub?.grace_period_expires_date);
  const billingIssue = Boolean(sub?.billing_issues_detected_at);

  let status;
  if (sub?.refunded_at) status = 'refunded';
  else if (!expiresAt || expiresAt > now) status = billingIssue ? 'billing_issue' : 'active';
  else if (graceExpiresAt && graceExpiresAt > now) status = 'in_grace';
  else status = 'expired';

  const store =
    sub?.store ?? (ent.product_identifier?.startsWith('rc_promo') ? 'promotional' : null);
  return {
    productId,
    store: store ? (STORES.has(store) ? store : 'other') : null,
    environment: sub?.is_sandbox ? 'sandbox' : 'production',
    periodType: PERIODS.has(sub?.period_type) ? sub.period_type : null,
    status,
    willRenew:
      ['active', 'billing_issue', 'in_grace'].includes(status) &&
      Boolean(expiresAt) &&
      !sub?.unsubscribe_detected_at,
    purchasedAt: date(ent.purchase_date ?? sub?.purchase_date),
    expiresAt,
    graceExpiresAt,
    managementUrl: subscriber.management_url ?? null,
  };
}

/** Premium sayılır mı? (sandbox ayarı çağırandadır) */
export function grantsAccess(s, now = new Date()) {
  if (!s) return false;
  if (['active', 'billing_issue'].includes(s.status)) return !s.expiresAt || s.expiresAt > now;
  if (s.status === 'in_grace') return Boolean(s.graceExpiresAt && s.graceExpiresAt > now);
  return false;
}

export function createRevenueCatClient(config, { fetchImpl = fetch, logger } = {}) {
  async function request(method, path, body) {
    if (!config.enabled) {
      throw new AppError('UNAVAILABLE', { details: { reason: 'billing_disabled' } });
    }
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.secretApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger?.warn(
        { status: res.status, path: path.replace(/subscribers\/[^/]+/, 'subscribers/:id') },
        'RevenueCat isteği başarısız',
      );
      throw new AppError('UNAVAILABLE', {
        details: { reason: 'billing_upstream', status: res.status },
      });
    }
    return res.json();
  }

  return {
    enabled: config.enabled,

    /** Abonenin güncel durumu (yoksa RevenueCat boş abone döner). */
    async subscriber(appUserId) {
      return request('GET', `/subscribers/${encodeURIComponent(appUserId)}`);
    },

    /** Süreli promosyon premium (destek/admin). `duration`: daily … lifetime. */
    async grantPromotional(appUserId, entitlement, duration) {
      return request(
        'POST',
        `/subscribers/${encodeURIComponent(appUserId)}/entitlements/${encodeURIComponent(entitlement)}/promotional`,
        { duration },
      );
    },
  };
}
