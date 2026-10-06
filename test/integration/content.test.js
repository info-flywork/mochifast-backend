import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { loadCatalogSeeds, seedCatalog } from '../../src/modules/catalog/catalog.seeder.js';
import { createIntegrationApp } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');

describe.skipIf(!mysqlUrl)('içerik katalogları (gerçek MySQL)', () => {
  let ctx;
  let get;

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    get = (url, lang = 'en', headers = {}) =>
      ctx.call('GET', url, { headers: { 'accept-language': lang, ...headers } });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('vücut evreleri: 9 evre, saatler, görseller; yeme penceresi: 3 evre', async () => {
    const res = await get('/catalog/stages?type=body', 'tr');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    const { type, items } = res.json().data;
    expect(type).toBe('body');
    expect(items.map((s) => [s.startHour, s.endHour])).toEqual([
      [0, 2],
      [2, 5],
      [5, 8],
      [8, 12],
      [12, 16],
      [16, 18],
      [18, 24],
      [24, 48],
      [48, null],
    ]);
    expect(items[0]).toMatchObject({
      position: 1,
      rangeLabel: '0 sa - 2 sa',
      imageKey: 'a1',
      images: { idle: 'assets/images/1.png', reached: 'assets/images/1_light.png' },
    });
    expect(items[0].title).not.toBe('Blood Sugar Rises');

    const eating = (await get('/catalog/stages?type=eating_window')).json().data;
    expect(eating.type).toBe('eatingWindow');
    expect(eating.items.map((s) => s.imageKey)).toEqual(['break', 'nourish', 'next']);
    expect(eating.items[1].images.idle).not.toBe(eating.items[1].images.reached);
  });

  it('zorlanma: sebep → ipucu eşleşmesi ve etkinlik parametreleri uygulamayla aynı', async () => {
    const data = (await get('/catalog/struggle')).json().data;
    expect(data.intro.title).toBe('Hey, squish');
    expect(Object.fromEntries(data.reasons.map((r) => [r.code, r.tips]))).toEqual({
      hungry: ['hydration', 'walk'],
      craving: ['breathe'],
      energy: ['walk'],
      stressed: ['hydration', 'breathe'],
      bored: ['hydration', 'walk', 'breathe'],
    });
    const tips = Object.fromEntries(data.tips.map((t) => [t.code, t]));
    expect(tips.hydration.activity).toEqual({ type: 'sips', sips: 8 });
    expect(tips.walk.activity).toEqual({ type: 'timer', seconds: 180 });
    expect(tips.breathe.activity).toEqual({
      type: 'breathing',
      inhale: 4,
      hold: 7,
      exhale: 8,
      rounds: 4,
    });
    expect(tips.walk.done).toEqual({
      title: 'Nice walk',
      body: "Three minutes on your feet. Back to the fast when you're ready.",
      button: 'Back to fasting',
    });
  });

  it('SSS ve sohbet önerileri; desteklenmeyen dil İngilizceye düşer', async () => {
    const faq = (await get('/catalog/faq', 'de')).json().data.items;
    expect(faq.map((f) => f.code)).toEqual([
      'what',
      'start',
      'beginner',
      'premium',
      'history',
      'cancel',
    ]);
    expect(faq[0].question).not.toBe('What is MochiFast?');
    const ja = (await get('/catalog/faq', 'ja')).json().data.items;
    expect(ja[0].question).toBe('What is MochiFast?');

    const chips = (await get('/catalog/chat-suggestions')).json().data.items;
    expect(chips.map((c) => c.code)).toEqual(['hungry', 'coffee', 'weight', 'eat']);
    expect(chips[1].text).toBe('Can I drink coffee while fasting?');
  });

  it('onboarding seçenekleri: API enum kodları, görseller, gün sayıları, plan kartları', async () => {
    const data = (await get('/catalog/onboarding-options', 'tr')).json().data;
    expect(data.goals.map((g) => g.code)).toEqual([
      'loseWeight',
      'buildHabit',
      'moreEnergy',
      'gutReset',
    ]);
    expect(data.goals[0]).toMatchObject({
      image: 'assets/images/weigher.png',
      badge: 'En Popüler',
    });
    expect(data.genders.map((g) => g.code)).toEqual([
      'woman',
      'man',
      'nonBinary',
      'preferNotToSay',
    ]);
    expect(data.diets.find((d) => d.code === 'lowCarb').subtitle).toBeTruthy();
    expect(data.foodLoves).toHaveLength(13);
    expect(data.foodSkips.map((f) => f.code)).toContain('tooSpicy');
    expect(data.weightHistories.map((w) => w.code)).toEqual([
      'manyTimes',
      'onceOrTwice',
      'firstTime',
    ]);
    expect(data.obstacles).toHaveLength(6);
    expect(Object.fromEntries(data.fastingReasons.map((r) => [r.code, r.days]))).toEqual({
      specialDate: 45,
      trip: 90,
      healthLongevity: 180,
      confidence: 120,
    });
    expect(data.plans.map((p) => p.code)).toEqual(['16_8', '14_10', '18_6', '20_4', 'omad', '5_2']);
    expect(data.plans[0]).toMatchObject({
      code: '16_8',
      fastHours: 16,
      isLocked: false,
      badgeColor: expect.stringMatching(/^#[0-9A-F]{6}([0-9A-F]{2})?$/),
    });
    expect(data.plans.find((p) => p.code === 'omad').isLocked).toBe(true);
  });

  it('Insights: kategoriler (renk, ikon, makale sayısı) ve kategoriye göre makaleler', async () => {
    const cats = (await get('/insights/categories')).json().data.items;
    expect(cats.map((c) => c.slug)).toEqual(['basics', 'during', 'eating', 'health', 'tips']);
    expect(cats[0]).toMatchObject({
      icon: 'tree',
      iconImage: 'assets/images/tree.png',
      bgColor: '#96BD8F33',
      articleCount: 1,
      isLocked: false,
    });
    expect(cats[1].bgColor).toBe('#FDEBE1');

    const during = (await get('/insights/articles?category=during')).json().data;
    expect(during.items.map((a) => a.slug)).toEqual(['what-happens-while-you-fast']);
    expect(during.items[0].readMinutes).toBeGreaterThanOrEqual(1);
  });

  it('Insights araması: bölüm metninde de arar, dile ve büyük harfe duyarsız', async () => {
    const water = (await get('/insights/articles?q=WATER')).json().data.items;
    expect(water.map((a) => a.slug)).toContain('what-happens-while-you-fast');
    // Kelime başı eşleşmesi: "ting" fasting/eating'in içinde geçer ama bir kelimeyi başlatmaz.
    expect((await get('/insights/articles?q=ting')).json().data.items).toEqual([]);
    expect((await get('/insights/articles?q=(a+b')).statusCode).toBe(200);
    const none = (await get('/insights/articles?q=kriptopara')).json().data;
    expect(none).toEqual({ items: [], pageInfo: { nextCursor: null, hasMore: false } });
    const tr = (await get(`/insights/articles?q=${encodeURIComponent('İPUCU')}`, 'tr')).json().data;
    expect(Array.isArray(tr.items)).toBe(true);
  });

  it('Insights sayfalama: imleçle sırayı korur, sonda hasMore false', async () => {
    const first = (await get('/insights/articles?limit=2')).json().data;
    expect(first.items).toHaveLength(2);
    expect(first.pageInfo.hasMore).toBe(true);
    const second = (
      await get(`/insights/articles?limit=2&cursor=${first.pageInfo.nextCursor}`)
    ).json().data;
    const third = (
      await get(`/insights/articles?limit=2&cursor=${second.pageInfo.nextCursor}`)
    ).json().data;
    const slugs = [...first.items, ...second.items, ...third.items].map((a) => a.slug);
    expect(slugs).toHaveLength(5);
    expect(new Set(slugs).size).toBe(5);
    expect(third.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    expect((await get('/insights/articles?cursor=bozuk')).statusCode).toBe(400);
  });

  it('makale detayı: bölümler sıralı, ikon görselleri; bilinmeyen slug 404; ETag 304', async () => {
    const res = await get('/insights/articles/what-is-intermittent-fasting', 'it');
    expect(res.statusCode).toBe(200);
    const a = res.json().data;
    expect(a.sections.map((s) => [s.position, s.icon])).toEqual([
      [1, 'tree'],
      [2, 'flame'],
      [3, 'window'],
    ]);
    expect(a).toMatchObject({ category: 'basics', isLocked: false });
    expect(a.quote).toBeTruthy();
    const again = await get('/insights/articles/what-is-intermittent-fasting', 'it', {
      'if-none-match': res.headers.etag,
    });
    expect(again.statusCode).toBe(304);
    expect((await get('/insights/articles/yok-boyle-bir-sey')).statusCode).toBe(404);
  });

  it('seed tekrar çalışınca içerik aynı kalır; çıkarılan makale arşivlenir, SSS pasifleşir', async () => {
    const seeds = await loadCatalogSeeds();
    const stats = await seedCatalog(ctx.db, seeds);
    expect(stats.content).toEqual({
      stages: 12,
      struggle: 5,
      insightArticles: 5,
      faq: 6,
      items: 60,
    });

    const trimmed = structuredClone(seeds);
    trimmed.content.insights.articles = trimmed.content.insights.articles.slice(1);
    trimmed.content.faq = trimmed.content.faq.slice(1);
    await seedCatalog(ctx.db, trimmed);
    await ctx.app.deps.cache.del('cfg:app:rows');
    const list = (await get('/insights/articles')).json().data.items.map((a) => a.slug);
    expect(list).not.toContain('what-is-intermittent-fasting');
    expect((await get('/catalog/faq')).json().data.items.map((f) => f.code)).not.toContain('what');

    await seedCatalog(ctx.db, seeds);
    await ctx.app.deps.cache.del('cfg:app:rows');
    expect((await get('/insights/articles')).json().data.items).toHaveLength(5);
  });
});
