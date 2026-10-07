import { describe, expect, it } from 'vitest';
import { grantsAccess, mapSubscriber, webhookAuthorized } from '../../src/infra/revenuecat.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const iso = (days) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

/** RevenueCat v1 abone yanıtı biçimi. */
function subscriber({ expires = iso(20), sub = {}, product = 'mochifast_premium_monthly' } = {}) {
  return {
    subscriber: {
      management_url: 'https://apps.apple.com/account/subscriptions',
      entitlements: {
        premium: { expires_date: expires, product_identifier: product, purchase_date: iso(-10) },
      },
      subscriptions: {
        [product]: {
          store: 'app_store',
          period_type: 'normal',
          is_sandbox: false,
          expires_date: expires,
          ...sub,
        },
      },
    },
  };
}

describe('RevenueCat abone eşlemesi (11 §3)', () => {
  it('aktif, yenilenecek', () => {
    const s = mapSubscriber(subscriber(), 'premium', NOW);
    expect(s).toMatchObject({
      status: 'active',
      willRenew: true,
      store: 'app_store',
      environment: 'production',
      periodType: 'normal',
      productId: 'mochifast_premium_monthly',
      managementUrl: 'https://apps.apple.com/account/subscriptions',
    });
    expect(grantsAccess(s, NOW)).toBe(true);
  });

  it('deneme süresi ve iptal edilmiş (süre sonuna kadar aktif, yenilenmez)', () => {
    const trial = mapSubscriber(subscriber({ sub: { period_type: 'trial' } }), 'premium', NOW);
    expect(trial.periodType).toBe('trial');
    const cancelled = mapSubscriber(
      subscriber({ sub: { unsubscribe_detected_at: iso(-1) } }),
      'premium',
      NOW,
    );
    expect(cancelled).toMatchObject({ status: 'active', willRenew: false });
    expect(grantsAccess(cancelled, NOW)).toBe(true);
  });

  it('ödeme sorunu (süre içinde) ve ödemesiz ek süre (grace)', () => {
    const billing = mapSubscriber(
      subscriber({ sub: { billing_issues_detected_at: iso(-1) } }),
      'premium',
      NOW,
    );
    expect(billing.status).toBe('billing_issue');
    expect(grantsAccess(billing, NOW)).toBe(true);

    const grace = mapSubscriber(
      subscriber({ expires: iso(-1), sub: { grace_period_expires_date: iso(3) } }),
      'premium',
      NOW,
    );
    expect(grace.status).toBe('in_grace');
    expect(grantsAccess(grace, NOW)).toBe(true);
  });

  it('süresi geçmiş, iade, ömür boyu, sandbox, entitlement yok', () => {
    const expired = mapSubscriber(subscriber({ expires: iso(-2) }), 'premium', NOW);
    expect(expired).toMatchObject({ status: 'expired', willRenew: false });
    expect(grantsAccess(expired, NOW)).toBe(false);

    expect(
      mapSubscriber(subscriber({ sub: { refunded_at: iso(-1) } }), 'premium', NOW).status,
    ).toBe('refunded');

    const lifetime = mapSubscriber(subscriber({ expires: null }), 'premium', NOW);
    expect(lifetime).toMatchObject({ status: 'active', expiresAt: null, willRenew: false });
    expect(grantsAccess(lifetime, NOW)).toBe(true);

    expect(
      mapSubscriber(subscriber({ sub: { is_sandbox: true } }), 'premium', NOW).environment,
    ).toBe('sandbox');
    expect(mapSubscriber(subscriber(), 'other_entitlement', NOW)).toBeNull();
    expect(mapSubscriber({ subscriber: { entitlements: {} } }, 'premium', NOW)).toBeNull();
  });

  it('webhook yetkisi: sabit zamanlı karşılaştırma; ayar yoksa hep red', () => {
    expect(webhookAuthorized('Bearer abc', 'Bearer abc')).toBe(true);
    expect(webhookAuthorized('Bearer abd', 'Bearer abc')).toBe(false);
    expect(webhookAuthorized(undefined, 'Bearer abc')).toBe(false);
    expect(webhookAuthorized('', '')).toBe(false);
  });
});
