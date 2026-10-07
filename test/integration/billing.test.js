import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { billingJobs } from '../../src/jobs/billing.jobs.js';
import { createRevenueCatClient } from '../../src/infra/revenuecat.js';
import { billingServiceFor } from '../../src/modules/billing/billing.routes.js';
import { toBin } from '../../src/shared/ids.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const WEBHOOK_AUTH = 'Bearer test-webhook-secret-0123456789';
const errors = [];
const silent = { info() {}, warn() {}, error: (o, m) => errors.push([m, o?.err?.message]) };
const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

const onboardingBody = (planCode = '16_8') => ({
  schemaVersion: 1,
  goal: 'loseWeight',
  gender: 'woman',
  weightKg: 74,
  goalWeightKg: 64,
  heightCm: 172,
  age: 29,
  diet: 'everything',
  foodLoves: ['eggs'],
  weightHistory: 'firstTime',
  fastingReason: 'trip',
  planCode,
  mealWindow: { start: '07:00', end: '19:00' },
  consents: { terms: '2026-10', privacy: '2026-10', healthData: true },
});

/** RevenueCat abone kaydı (fake REST'in döneceği). */
function premium({ expires = iso(30), sandbox = false, sub = {} } = {}) {
  const product = 'mochifast_premium_monthly';
  return {
    entitlements: {
      premium: { expires_date: expires, product_identifier: product, purchase_date: iso(-1) },
    },
    subscriptions: {
      [product]: { store: 'app_store', period_type: 'normal', is_sandbox: sandbox, ...sub },
    },
    management_url: 'https://apps.apple.com/account/subscriptions',
  };
}

describe.skipIf(!mysqlUrl)('abonelik: RevenueCat (gerçek MySQL, sahte REST)', () => {
  let ctx;
  let call;
  let jobs;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl, { REVENUECAT_WEBHOOK_AUTH: WEBHOOK_AUTH });
    ({ call } = ctx);
    jobs = billingJobs({
      db: ctx.db,
      config: ctx.config,
      logger: silent,
      revenuecat: createRevenueCatClient(
        { ...ctx.config.billing, enabled: true, secretApiKey: 'sk_test' },
        { fetchImpl: ctx.revenuecatApi.fetch },
      ),
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function newUser(planCode) {
    const { token, user } = (await ctx.guest(randomUUID())).json().data;
    if (planCode) {
      await call('POST', '/user/onboarding', {
        token: token.accessToken,
        body: onboardingBody(planCode),
      });
    }
    return { token: token.accessToken, userId: user.id };
  }
  const get = async (token, url) => (await call('GET', url, { token })).json().data;
  const webhook = (body, auth = WEBHOOK_AUTH) =>
    call('POST', '/webhooks/revenuecat', { body, headers: { authorization: auth } });

  it('kabul kriteri: satın alma sonrası sync ile anında premium; kilitler açılır', async () => {
    const { token, userId } = await newUser('16_8');
    expect((await get(token, '/subscription')).subscription).toMatchObject({
      isPremium: false,
      status: null,
    });
    expect(
      (await call('PUT', '/plans/current', { token, body: { planCode: '18_6' } })).statusCode,
    ).toBe(402);

    ctx.revenuecatApi.subscribers[userId] = premium();
    const synced = (await call('POST', '/subscription/sync', { token })).json().data.subscription;
    expect(synced).toMatchObject({
      isPremium: true,
      status: 'active',
      store: 'app_store',
      willRenew: true,
      productId: 'mochifast_premium_monthly',
    });
    expect((await get(token, '/user/me')).isPremium).toBe(true);
    expect(
      (await call('PUT', '/plans/current', { token, body: { planCode: '18_6' } })).statusCode,
    ).toBe(200);
    expect((await get(token, '/chat/quota')).chat).toMatchObject({ limit: 100 });
    expect(
      (await get(token, '/catalog/plans')).groups.flatMap((g) => g.plans).every((p) => !p.isLocked),
    ).toBe(true);
  });

  it("onboarding'de seçilen premium plan, premium gelince kendiliğinden etkinleşir", async () => {
    const { token, userId } = await newUser('18_6');
    expect(await get(token, '/plans/current')).toMatchObject({
      plan: null,
      pendingPlanCode: '18_6',
    });
    ctx.revenuecatApi.subscribers[userId] = premium();
    await call('POST', '/subscription/sync', { token });
    expect(await get(token, '/plans/current')).toMatchObject({
      plan: { planCode: '18_6' },
      pendingPlanCode: null,
    });
  });

  it('kabul kriteri: aynı webhook iki kez → tek kez işlenir; yetkisiz 401', async () => {
    const { token, userId } = await newUser('16_8');
    ctx.revenuecatApi.subscribers[userId] = premium();
    const event = {
      api_version: '1.0',
      event: {
        id: randomUUID(),
        type: 'INITIAL_PURCHASE',
        app_user_id: userId,
        environment: 'PRODUCTION',
      },
    };
    expect((await webhook(event, 'Bearer wrong')).statusCode).toBe(401);
    const first = await webhook(event);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toEqual({ received: true, duplicate: false });
    expect((await webhook(event)).json().data).toEqual({ received: true, duplicate: true });
    const queued = await ctx.db.many(
      "SELECT payload FROM jobs WHERE queue = 'billing' AND name = 'revenuecatEvent' AND dedupe_key = :k",
      { k: `rc:${event.event.id}` },
    );
    expect(queued).toHaveLength(1);

    const before = ctx.revenuecatApi.calls.length;
    await jobs.revenuecatEvent({ payload: { eventId: event.event.id } });
    await jobs.revenuecatEvent({ payload: { eventId: event.event.id } });
    expect(ctx.revenuecatApi.calls.length - before).toBe(1);
    const row = await ctx.db.one(
      'SELECT processed_at, error FROM revenuecat_events WHERE event_id = :id',
      {
        id: event.event.id,
      },
    );
    expect(row.processed_at).toBeTruthy();
    expect(row.error).toBeNull();
    // Worker API'nin önbelleğini silemez (en geç 30 sn eski kalır); yansıma DB'de hemen günceldir.
    const sub = await ctx.db.one('SELECT status FROM subscriptions WHERE user_id = :u', {
      u: toBin(userId),
    });
    expect(sub.status).toBe('active');
    expect(
      (await call('POST', '/subscription/sync', { token })).json().data.subscription.isPremium,
    ).toBe(true);
  });

  it('TRANSFER iki tarafı da senkronlar; anonim kullanıcı olayı not edilir', async () => {
    const a = await newUser();
    const b = await newUser();
    await ctx.db.run(
      `INSERT INTO subscriptions (id, user_id, entitlement, status, last_synced_at, expires_at)
       VALUES (:id, :u, 'premium', 'active', NOW(3), DATE_ADD(NOW(3), INTERVAL 10 DAY))`,
      { id: toBin(randomUUID()), u: toBin(a.userId) },
    );
    ctx.revenuecatApi.subscribers[b.userId] = premium();
    const id = randomUUID();
    await webhook({
      event: {
        id,
        type: 'TRANSFER',
        app_user_id: b.userId,
        transferred_from: [a.userId],
        transferred_to: [b.userId],
        environment: 'PRODUCTION',
      },
    });
    await jobs.revenuecatEvent({ payload: { eventId: id } });
    const status = async (u) =>
      (await ctx.db.one('SELECT status FROM subscriptions WHERE user_id = :u', { u: toBin(u) }))
        .status;
    expect(await status(a.userId)).toBe('expired');
    expect(await status(b.userId)).toBe('active');

    const anon = randomUUID();
    await webhook({
      event: {
        id: anon,
        type: 'INITIAL_PURCHASE',
        app_user_id: '$RCAnonymousID:abc',
        environment: 'PRODUCTION',
      },
    });
    await jobs.revenuecatEvent({ payload: { eventId: anon } });
    expect(
      (await ctx.db.one('SELECT error FROM revenuecat_events WHERE event_id = :id', { id: anon }))
        .error,
    ).toBe('anonymous_user');
  });

  it("kabul kriteri: süresi dolan abonelikte ertesi gün premium plan 16:8'e düşer, inbox kaydı", async () => {
    const { token, userId } = await newUser('16_8');
    ctx.revenuecatApi.subscribers[userId] = premium();
    await call('POST', '/subscription/sync', { token });
    const put = await call('PUT', '/plans/current', { token, body: { planCode: '18_6' } });
    expect(put.statusCode).toBe(200);

    // Abonelik dün bitti.
    ctx.revenuecatApi.subscribers[userId] = premium({ expires: iso(-1.5) });
    await billingServiceFor(ctx.app).sync(userId, { source: 'webhook' });
    expect((await get(token, '/subscription')).subscription).toMatchObject({
      isPremium: false,
      status: 'expired',
    });

    await jobs.premiumDowngrade();
    expect(errors).toEqual([]);
    expect((await get(token, '/plans/current')).plan).toMatchObject({ planCode: '16_8' });
    const inbox = await ctx.db.one(
      'SELECT type, CAST(params AS CHAR) AS params FROM notifications WHERE user_id = :u',
      { u: toBin(userId) },
    );
    expect(inbox.type).toBe('premium_expired');
    expect(JSON.parse(inbox.params)).toEqual({ fromPlan: '18_6', toPlan: '16_8' });
  });

  it('sandbox satın alma: üretim dışında premium verir (ayarla); promosyon premium', async () => {
    const { token, userId } = await newUser('16_8');
    ctx.revenuecatApi.subscribers[userId] = premium({ sandbox: true });
    const sub = (await call('POST', '/subscription/sync', { token })).json().data.subscription;
    expect(sub).toMatchObject({
      environment: 'sandbox',
      isPremium: ctx.config.billing.allowSandbox,
    });

    const other = await newUser();
    await billingServiceFor(ctx.app).grantPromotional(other.userId, 'monthly');
    expect((await get(other.token, '/subscription')).subscription).toMatchObject({
      isPremium: true,
    });
    const audit = await ctx.db.one(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'subscription.promotional_granted' AND entity_id = :id",
      { id: other.userId },
    );
    expect(Number(audit.n)).toBe(1);
  });
});
