import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId, toBin } from '../../src/shared/ids.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const H = 3_600_000;
const ago = (hours) => new Date(Date.now() - hours * H).toISOString();

const onboardingBody = (overrides = {}) => ({
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
  planCode: '16_8',
  mealWindow: { start: '07:00', end: '19:00' },
  consents: { terms: '2026-10', privacy: '2026-10', healthData: true },
  ...overrides,
});

describe.skipIf(!mysqlUrl)('plan & oruç (gerçek MySQL)', () => {
  let ctx;
  let call;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    ({ call } = ctx);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function newUser({ timezone = 'Europe/Istanbul', onboarding } = {}) {
    const { token, user } = (await ctx.guest(randomUUID(), { timezone })).json().data;
    const t = token.accessToken;
    if (onboarding !== false) {
      const res = await call('POST', '/user/onboarding', {
        token: t,
        body: onboardingBody(onboarding),
        headers: { 'x-timezone': timezone },
      });
      expect(res.statusCode).toBe(200);
    }
    return { token: t, userId: user.id };
  }
  const start = (token, body = {}, headers) => call('POST', '/fasts', { token, body, headers });

  // ── Planlar ─────────────────────────────────────────────────────────
  it('onboarding planı aktif plana bağlanır; premium plan bekler', async () => {
    const free = await newUser();
    const cur = (await call('GET', '/plans/current', { token: free.token })).json().data;
    expect(cur.pendingPlanCode).toBeNull();
    expect(cur.plan).toMatchObject({
      planCode: '16_8',
      displayName: '16:8',
      timing: 'custom',
      fastMinutes: 960,
      eatWindow: { start: '11:00', end: '19:00' },
      isPremium: false,
    });

    const premium = await newUser({
      onboarding: { planCode: 'early_tre', mealWindow: { start: '07:00', end: '15:00' } },
    });
    const p = (await call('GET', '/plans/current', { token: premium.token })).json().data;
    expect(p).toEqual({ plan: null, pendingPlanCode: 'early_tre' });
  });

  it('plan değişimi: zamanlama → pencere; premium 402; uyumsuz özel pencere 400; geçmiş', async () => {
    const { token } = await newUser();
    const res = await call('PUT', '/plans/current', {
      token,
      body: { planCode: '14_10', timing: 'skipDinner' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.plan).toMatchObject({
      planCode: '14_10',
      timing: 'skipDinner',
      fastMinutes: 840,
      eatWindow: { start: '08:00', end: '18:00' },
    });

    const premium = await call('PUT', '/plans/current', { token, body: { planCode: '18_6' } });
    expect(premium.statusCode).toBe(402);
    expect(premium.json().error).toMatchObject({
      code: 'PREMIUM_REQUIRED',
      details: { planCode: '18_6' },
    });

    const bad = await call('PUT', '/plans/current', {
      token,
      body: { planCode: '16_8', timing: 'custom', eatWindow: { start: '10:00', end: '20:00' } },
    });
    expect(bad.statusCode).toBe(400);

    const history = (await call('GET', '/plans/history', { token })).json().data;
    expect(history.items.map((i) => i.planCode)).toEqual(['14_10', '16_8']);
    expect(history.items[0].endedAt).toBeNull();
    expect(history.items[1].endedAt).not.toBeNull();
  });

  it('plan sağlık kuralı: 18 yaş altı 15:9 seçemez (422)', async () => {
    const { token } = await newUser({ onboarding: { age: 16, planCode: '14_10' } });
    const res = await call('PUT', '/plans/current', { token, body: { planCode: '15_9' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('UNSAFE_REQUEST');
  });

  // ── Oruç ────────────────────────────────────────────────────────────
  it('başlat → aktif (canlı süre, ilerleme, evre) → ikinci başlatma 409', async () => {
    const { token } = await newUser();
    const res = await start(token, { startedAt: ago(13) });
    expect(res.statusCode).toBe(201);
    const fast = res.json().data.fast;
    expect(fast).toMatchObject({ status: 'active', planCode: '16_8', targetMinutes: 960 });

    const active = (await call('GET', '/fasts/active', { token })).json().data;
    expect(active.eatingWindow).toBeNull();
    expect(active.fast.elapsedMinutes).toBeGreaterThanOrEqual(779);
    expect(active.fast.progress).toBeCloseTo(0.81, 1);
    expect(active.fast.stage).toMatchObject({ position: 5, imageKey: 'a5' });
    expect(active.fast.stage.nextStageAt).toBeTruthy();
    expect(active.fast.serverTime).toBeTruthy();

    const again = await start(token);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({
      code: 'ACTIVE_FAST_EXISTS',
      details: { activeFastId: fast.id },
    });
  });

  it('kabul kriteri: eşzamanlı 10 başlatma → yalnızca 1 başarı', async () => {
    const { token } = await newUser();
    const results = await Promise.all(Array.from({ length: 10 }, () => start(token)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(9);
  });

  it('istemci id ile tekrar gönderim aynı orucu döner (200)', async () => {
    const { token } = await newUser();
    const id = newId();
    const a = await start(token, { id, startedAt: ago(1) });
    const b = await start(token, { id, startedAt: ago(1) });
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().data.fast.id).toBe(id);
  });

  it('Idempotency-Key: aynı istek aynı yanıt; aynı anahtar farklı gövde 409', async () => {
    const { token } = await newUser();
    const fast = (await start(token, { startedAt: ago(17) })).json().data.fast;
    const key = randomUUID();
    const finish = (body) =>
      call('POST', `/fasts/${fast.id}/finish`, {
        token,
        body,
        headers: { 'idempotency-key': key },
      });
    const first = await finish({ feeling: 'good' });
    expect(first.statusCode).toBe(200);
    const replay = await finish({ feeling: 'good' });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    const reused = await finish({ feeling: 'meh' });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('bitir: hedef altı endedEarly, üstü completed; ilk oruç bir kez; kilo ve şifreli not', async () => {
    const { token, userId } = await newUser();
    const early = (await start(token, { startedAt: ago(60) })).json().data.fast;
    const e = await call('POST', `/fasts/${early.id}/finish`, {
      token,
      body: { endedAt: ago(47) },
    });
    expect(e.json().data).toMatchObject({
      fast: { status: 'endedEarly', durationMinutes: 780, goalReached: false },
      isFirstFast: false,
    });

    const done = (await start(token, { startedAt: ago(40) })).json().data.fast;
    const d = await call('POST', `/fasts/${done.id}/finish`, {
      token,
      body: { endedAt: ago(23), feeling: 'super', notes: 'Kolay geçti 🙂', weightKg: 72.4 },
    });
    expect(d.json().data).toMatchObject({
      fast: { status: 'completed', goalReached: true, feeling: 'super', notes: 'Kolay geçti 🙂' },
      isFirstFast: true,
      warnings: [],
    });

    const row = await ctx.db.one(
      'SELECT notes_enc, weight_entry_id FROM fasting_sessions WHERE id = :id',
      {
        id: toBin(done.id),
      },
    );
    expect(row.notes_enc.toString()).not.toContain('Kolay');
    const weight = await ctx.db.one(
      "SELECT weight_kg FROM weight_entries WHERE user_id = :u AND source = 'fasting_finish'",
      { u: toBin(userId) },
    );
    expect(weight.weight_kg).toBe(72.4);

    const third = (await start(token, { startedAt: ago(1) })).json().data.fast;
    const t = await call('POST', `/fasts/${third.id}/finish`, { token, body: { endedAt: ago(0) } });
    expect(t.json().data.isFirstFast).toBe(false);
  });

  it('kabul kriteri: İstanbul 20:00 → 12:00 orucu bitiş gününe yazılır', async () => {
    const { token } = await newUser({ timezone: 'Europe/Istanbul' });
    // 2026-10-01 20:00 İstanbul = 17:00Z; 2026-10-02 12:00 İstanbul = 09:00Z
    const res = await call('POST', '/fasts/manual', {
      token,
      body: { startedAt: '2026-10-01T17:00:00.000Z', endedAt: '2026-10-02T09:00:00.000Z' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.fast).toMatchObject({
      status: 'completed',
      durationMinutes: 960,
      localDate: '2026-10-02',
      tz: 'Europe/Istanbul',
      source: 'manualLog',
    });
  });

  it('çakışma ve zaman sınırları', async () => {
    const { token } = await newUser();
    await call('POST', '/fasts/manual', {
      token,
      body: { startedAt: ago(48), endedAt: ago(32) },
    });
    const overlap = await call('POST', '/fasts/manual', {
      token,
      body: { startedAt: ago(40), endedAt: ago(30) },
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error.code).toBe('FAST_OVERLAP');
    expect((await start(token, { startedAt: ago(24 * 8) })).statusCode).toBe(400);
    expect(
      (await start(token, { startedAt: new Date(Date.now() + 10 * 60_000).toISOString() }))
        .statusCode,
    ).toBe(400);
    // Aktif orucun planlanan aralığına giren geçmiş kayıt da çakışır.
    await start(token, { startedAt: ago(2) });
    const intoActive = await call('POST', '/fasts/manual', {
      token,
      body: { startedAt: ago(3), endedAt: ago(1) },
    });
    expect(intoActive.json().error.code).toBe('FAST_OVERLAP');
  });

  it('iptal: 10 dk içinde iz bırakmaz, sonra cancelled', async () => {
    const { token } = await newUser();
    const quick = (await start(token)).json().data.fast;
    const c1 = await call('POST', `/fasts/${quick.id}/cancel`, { token });
    expect(c1.json().data).toEqual({ id: quick.id, deleted: true });
    expect((await call('GET', `/fasts/${quick.id}`, { token })).statusCode).toBe(404);

    const later = (await start(token, { startedAt: ago(0.5) })).json().data.fast;
    const c2 = await call('POST', `/fasts/${later.id}/cancel`, { token });
    expect(c2.json().data.deleted).toBe(false);
    expect((await call('GET', `/fasts/${later.id}`, { token })).json().data.fast.status).toBe(
      'cancelled',
    );
    expect((await call('GET', '/fasts/active', { token })).json().data.fast).toBeNull();
  });

  it('düzenleme: aktifte hedef; bitmişte bitiş → durum yeniden hesaplanır', async () => {
    const { token } = await newUser();
    const f = (await start(token, { startedAt: ago(5) })).json().data.fast;
    const p = await call('PATCH', `/fasts/${f.id}`, { token, body: { targetMinutes: 720 } });
    expect(p.json().data.fast).toMatchObject({ targetMinutes: 720, status: 'active' });

    await call('POST', `/fasts/${f.id}/finish`, { token, body: {} });
    const edited = await call('PATCH', `/fasts/${f.id}`, {
      token,
      body: { startedAt: ago(14), feeling: 'good', notes: 'düzeltildi' },
    });
    expect(edited.json().data.fast).toMatchObject({
      status: 'completed',
      goalReached: true,
      feeling: 'good',
      notes: 'düzeltildi',
    });
  });

  it('silme yumuşak; aktif silinemez; başkasının orucu 404', async () => {
    const owner = await newUser();
    const f = (
      await call('POST', '/fasts/manual', {
        token: owner.token,
        body: { startedAt: ago(30), endedAt: ago(14) },
      })
    ).json().data.fast;
    const stranger = await newUser();
    expect((await call('GET', `/fasts/${f.id}`, { token: stranger.token })).statusCode).toBe(404);
    expect((await call('DELETE', `/fasts/${f.id}`, { token: stranger.token })).statusCode).toBe(
      404,
    );

    expect((await call('DELETE', `/fasts/${f.id}`, { token: owner.token })).statusCode).toBe(200);
    expect((await call('GET', `/fasts/${f.id}`, { token: owner.token })).statusCode).toBe(404);
    const active = (await start(owner.token)).json().data.fast;
    expect((await call('DELETE', `/fasts/${active.id}`, { token: owner.token })).statusCode).toBe(
      409,
    );
  });

  it('geçmiş: yeniden eskiye, imleçle sayfalı, durum süzgeci', async () => {
    const { token } = await newUser();
    for (const [s, e] of [
      [100, 84],
      [80, 66],
      [60, 48],
    ]) {
      await call('POST', '/fasts/manual', { token, body: { startedAt: ago(s), endedAt: ago(e) } });
    }
    const p1 = (await call('GET', '/fasts?limit=2', { token })).json().data;
    expect(p1.items).toHaveLength(2);
    expect(p1.pageInfo.hasMore).toBe(true);
    const p2 = (
      await call('GET', `/fasts?limit=2&cursor=${p1.pageInfo.nextCursor}`, { token })
    ).json().data;
    expect(p2.items).toHaveLength(1);
    const all = [...p1.items, ...p2.items].map((f) => f.startedAt);
    expect([...all].sort().reverse()).toEqual(all);
    const early = (await call('GET', '/fasts?status=endedEarly', { token })).json().data.items;
    expect(early.every((f) => f.status === 'endedEarly')).toBe(true);
    expect(early).toHaveLength(2);
  });

  it('bitişten sonra yeme penceresi evresi; zorlanma kaydı', async () => {
    const { token } = await newUser();
    const f = (await start(token, { startedAt: ago(16.2) })).json().data.fast;
    const s = await call('POST', `/fasts/${f.id}/struggles`, {
      token,
      body: { reason: 'hungry', tip: 'hydration', tipCompleted: true, outcome: 'keepGoing' },
    });
    expect(s.statusCode).toBe(201);
    expect(s.json().data.elapsedMinutes).toBeGreaterThanOrEqual(970);

    await call('POST', `/fasts/${f.id}/finish`, { token, body: {} });
    const w = (
      await call('GET', '/fasts/active', { token, headers: { 'accept-language': 'tr' } })
    ).json().data;
    expect(w.fast).toBeNull();
    expect(w.eatingWindow).toMatchObject({
      lastFastId: f.id,
      eatMinutes: 480,
      stage: { key: 'break' },
    });
    expect(w.eatingWindow.stage.title).toBeTruthy();

    const free = await call('POST', '/struggles', { token, body: { reason: 'bored' } });
    expect(free.statusCode).toBe(201);
    expect(free.json().data.elapsedMinutes).toBeNull();
  });

  it('planı olmayan kullanıcı: varsayılan 16 sa hedef', async () => {
    const { token } = await newUser({ onboarding: false });
    const f = (await start(token)).json().data.fast;
    expect(f).toMatchObject({ targetMinutes: 960, planCode: null });
  });
});
