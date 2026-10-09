import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { aiJobs } from '../../src/jobs/ai.jobs.js';
import * as chatRepo from '../../src/modules/chat/chat.repository.js';
import { chatServiceFor } from '../../src/modules/chat/chat.routes.js';
import { newId, toBin } from '../../src/shared/ids.js';
import { createIntegrationApp, openAiChunks, setFeatureFlag } from '../helpers/app.js';

const mysqlUrl = inject('mysqlUrl');
const silent = { info() {}, warn() {}, error() {} };

/** SSE gövdesi → [{event, data}] (yorum satırları atlanır). */
function parseSse(body) {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) };
    });
}

describe.skipIf(!mysqlUrl)('Coach Mochi sohbeti (gerçek MySQL, sahte OpenAI)', () => {
  let ctx;

  const setChatQuota = (enabled) => setFeatureFlag(ctx, 'chatQuota', enabled);

  beforeAll(async () => {
    ctx = await createIntegrationApp(mysqlUrl);
    // Kota kabul kriterleri kota açıkken test edilir; kapalı durum ayrı testte.
    await setChatQuota(true);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function newUser({ consent = true } = {}) {
    const { token, user } = (await ctx.guest(randomUUID(), { locale: 'tr' })).json().data;
    if (consent) {
      await ctx.call('POST', '/user/consents', {
        token: token.accessToken,
        body: { type: 'aiProcessing', version: '2026-10', granted: true },
      });
    }
    return { token: token.accessToken, userId: user.id };
  }
  const conversation = async (token, body = {}) =>
    (await ctx.call('POST', '/chat/conversations', { token, body })).json().data.conversation;
  const send = (token, convId, body, accept = 'text/event-stream') =>
    ctx.call('POST', `/chat/conversations/${convId}/messages`, {
      token,
      body,
      headers: { accept, 'accept-language': 'tr' },
    });

  it('SSE: message.created → delta → message.completed; bağlam bloğu; şifreli saklama', async () => {
    const { token, userId } = await newUser();
    const conv = await conversation(token);
    ctx.openai.respond(() => openAiChunks(['Evet squish! ', 'Sade kahve orucu bozmaz ☕']));
    const before = ctx.openai.calls.length;
    const res = await send(token, conv.id, { text: 'Kahve içebilir miyim?' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual([
      'message.created',
      'delta',
      'delta',
      'message.completed',
    ]);
    const { assistantMessageId } = events[0].data;
    expect(events.at(-1).data).toMatchObject({
      assistantMessageId,
      status: 'complete',
      safety: 'none',
      usage: { remainingToday: 2 },
    });

    const request = ctx.openai.calls[before];
    expect(request).toMatchObject({
      model: 'test-chat-model',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toContain('Coach Mochi');
    const last = request.messages.at(-1);
    expect(last.role).toBe('user');
    expect(last.content).toMatch(/^<user_context>\n/);
    expect(last.content).toContain('language: Turkish');
    expect(last.content.endsWith('\n\nKahve içebilir miyim?')).toBe(true);

    const messages = (
      await ctx.call('GET', `/chat/conversations/${conv.id}/messages`, { token })
    ).json().data.items;
    expect(messages.map((m) => [m.role, m.text, m.status])).toEqual([
      ['user', 'Kahve içebilir miyim?', 'complete'],
      ['assistant', 'Evet squish! Sade kahve orucu bozmaz ☕', 'complete'],
    ]);
    const raw = await ctx.db.one('SELECT content_enc FROM chat_messages WHERE id = :id', {
      id: toBin(assistantMessageId),
    });
    expect(raw.content_enc.toString('utf8')).not.toContain('kahve');

    const usage = await ctx.db.one(
      "SELECT requests, input_tokens, output_tokens FROM ai_usage_daily WHERE user_id = :id AND feature = 'chat'",
      { id: toBin(userId) },
    );
    expect(usage).toMatchObject({ requests: 1, input_tokens: 900, output_tokens: 60 });

    const list = (await ctx.call('GET', '/chat/conversations', { token })).json().data.items;
    expect(list[0]).toMatchObject({ id: conv.id, title: 'Kahve içebilir miyim?', messageCount: 2 });
  });

  it('prompt cache: önceki tur birebir aynı yeniden kurulur; kabul kriteri: 4. mesaj 429', async () => {
    const { token } = await newUser();
    const conv = await conversation(token);
    ctx.openai.respond(() => openAiChunks(['Tamam!']));
    const start = ctx.openai.calls.length;
    for (const text of ['Merhaba', 'Su içtim', 'Acıktım']) {
      expect((await send(token, conv.id, { text })).statusCode).toBe(200);
    }
    const [first, second] = ctx.openai.calls.slice(start, start + 2);
    // İkinci istekteki ilk kullanıcı mesajı, birinci istekte gönderilenle byte'ı byte'ına aynı.
    expect(second.messages[1]).toEqual(first.messages.at(-1));
    expect(second.messages[2]).toEqual({ role: 'assistant', content: 'Tamam!' });

    const fourth = await send(token, conv.id, { text: 'Bir şey daha' });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.headers['content-type']).toContain('application/json');
    expect(fourth.json().error.details).toMatchObject({
      kind: 'chat',
      limit: 3,
      used: 3,
      upgradeAvailable: true,
    });
    const quota = (await ctx.call('GET', '/chat/quota', { token })).json().data.chat;
    expect(quota).toMatchObject({ used: 3, remaining: 0 });
  });

  it('features.chatQuota kapalı: limit uygulanmaz, sayaç düşmez, kalan hak null', async () => {
    await setChatQuota(false);
    try {
      const { token } = await newUser();
      const conv = await conversation(token);
      ctx.openai.respond(() => openAiChunks(['Tamam!']));
      let last;
      for (const text of ['Bir', 'İki', 'Üç', 'Dört']) {
        last = await send(token, conv.id, { text });
        expect(last.statusCode).toBe(200);
      }
      const completed = parseSse(last.body).find((e) => e.event === 'message.completed');
      expect(completed.data.usage).toEqual({ remainingToday: null });
      const quota = (await ctx.call('GET', '/chat/quota', { token })).json().data.chat;
      expect(quota).toMatchObject({ used: 0, limit: null, remaining: null });
    } finally {
      await setChatQuota(true);
    }
  });

  it('aynı konuşmada eşzamanlı ikinci istek → 409 REPLY_IN_PROGRESS', async () => {
    const { token } = await newUser();
    const conv = await conversation(token);
    ctx.openai.respond((_params, options) =>
      openAiChunks(['a', 'b', 'c'], { delayMs: 150, signal: options?.signal }),
    );
    const first = send(token, conv.id, { text: 'Uzun cevap' });
    await new Promise((r) => setTimeout(r, 60));
    const second = await send(token, conv.id, { text: 'Araya giren' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('REPLY_IN_PROGRESS');
    expect((await first).statusCode).toBe(200);
  });

  it('kabul kriteri: bağlantı koparsa model çağrısı iptal edilir, metin interrupted saklanır', async () => {
    const { token, userId } = await newUser();
    const conv = await conversation(token);
    let seenSignal;
    ctx.openai.respond((_params, options) => {
      seenSignal = options.signal;
      return openAiChunks(['Birinci ', 'ikinci ', 'üçüncü'], {
        delayMs: 50,
        signal: options.signal,
      });
    });
    const service = chatServiceFor(ctx.app);
    const turn = await service.prepare(userId, conv.id, { text: 'Anlat' }, 'tr');
    const client = new AbortController();
    const events = [];
    await service.stream(turn, {
      signal: client.signal,
      event: (name) => {
        events.push(name);
        if (name === 'delta') client.abort(); // istemci ilk parçadan sonra ayrıldı
      },
    });
    expect(seenSignal.aborted).toBe(true);
    const msg = await service.getMessage(userId, turn.assistantMessageId);
    expect(msg).toMatchObject({ status: 'interrupted', text: 'Birinci ' });
    expect(events).not.toContain('message.completed');
    // Yarıda kesilen yanıt hak düşürür (model çalıştı).
    expect((await ctx.call('GET', '/chat/quota', { token })).json().data.chat.used).toBe(1);
  });

  it('ret → yerelleştirilmiş mesaj (JSON yedek yolu); sağlayıcı hatası → error olayı + iade', async () => {
    const { token } = await newUser();
    const conv = await conversation(token);
    ctx.openai.respond(() => openAiChunks([], { refusal: 'no', finish: 'stop' }));
    const res = await send(token, conv.id, { text: 'Bir şey' }, 'application/json');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.assistantMessage).toMatchObject({
      status: 'refused',
      text: 'Bu konuda yardımcı olamıyorum, ama oruç ve beslenmeyle ilgili her şeyi sorabilirsin 💛',
    });

    ctx.openai.respond(() => {
      throw Object.create(OpenAI.RateLimitError.prototype);
    });
    const failed = parseSse((await send(token, conv.id, { text: 'Tekrar' })).body);
    expect(failed.map((e) => e.event)).toEqual(['message.created', 'error']);
    expect(failed[1].data).toMatchObject({ code: 'UNAVAILABLE' });
    expect((await ctx.call('GET', '/chat/quota', { token })).json().data.chat.used).toBe(1);
  });

  it('acil durum sinyali, tekrar gönderim, geri bildirim, sabitleme, başkasının konuşması', async () => {
    const { token } = await newUser();
    const conv = await conversation(token, { contextSource: 'hungerResult' });
    ctx.openai.respond(() => openAiChunks(['Lütfen orucunu hemen bitir.']));
    const id = newId();
    const urgent = parseSse(
      (await send(token, conv.id, { id, text: 'Başım çok dönüyor, bayılacak gibiyim' })).body,
    );
    expect(urgent[0].data.safety).toBe('urgent');
    expect(urgent.at(-1).data.safety).toBe('urgent');

    const calls = ctx.openai.calls.length;
    const replay = parseSse((await send(token, conv.id, { id, text: 'Başım çok dönüyor' })).body);
    expect(ctx.openai.calls.length).toBe(calls);
    expect(replay[0].data).toMatchObject({ replay: true });
    expect(replay[1].data.text).toBe('Lütfen orucunu hemen bitir.');

    const assistantId = urgent[0].data.assistantMessageId;
    expect(
      (
        await ctx.call('POST', `/chat/messages/${assistantId}/feedback`, {
          token,
          body: { rating: 'up' },
        })
      ).statusCode,
    ).toBe(200);

    const other = await newUser();
    expect(
      (await ctx.call('GET', `/chat/conversations/${conv.id}/messages`, { token: other.token }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await ctx.call('POST', `/chat/messages/${assistantId}/feedback`, {
          token: other.token,
          body: { rating: 'down' },
        })
      ).statusCode,
    ).toBe(404);

    const second = await conversation(token);
    await ctx.call('PATCH', `/chat/conversations/${conv.id}`, { token, body: { isPinned: true } });
    const list = (await ctx.call('GET', '/chat/conversations', { token })).json().data.items;
    expect(list.map((c) => c.id)).toEqual([conv.id, second.id]);
    expect(list[0]).toMatchObject({ isPinned: true, contextSource: 'hungerResult' });
    await ctx.call('DELETE', `/chat/conversations/${second.id}`, { token });
    expect(
      (await ctx.call('GET', '/chat/conversations', { token })).json().data.items,
    ).toHaveLength(1);
  });

  it('rıza yoksa 403; uzun sohbette özet üretilir ve sonraki turda sistem mesajı olarak gider', async () => {
    const noConsent = await newUser({ consent: false });
    const c0 = await conversation(noConsent.token);
    expect((await send(noConsent.token, c0.id, { text: 'Selam' })).statusCode).toBe(403);

    const { token, userId } = await newUser();
    const conv = await conversation(token);
    // 40 eski mesaj doğrudan yazılır (kota dışında).
    const t0 = Date.now() - 3_600_000;
    for (let i = 0; i < 40; i += 1) {
      const mid = newId();
      const role = i % 2 === 0 ? 'user' : 'assistant';
      await chatRepo.insertMessage(ctx.db, {
        id: mid,
        conversationId: conv.id,
        userId,
        role,
        contentEnc: ctx.crypto.encrypt(`${role} mesaj ${i}`, `chat_messages.content:${mid}`),
        status: 'complete',
        createdAt: new Date(t0 + i * 1000),
      });
    }
    await ctx.db.run('UPDATE chat_conversations SET message_count = 40 WHERE id = :id', {
      id: toBin(conv.id),
    });
    ctx.openai.respond(() => openAiChunks(['Tamam']));
    await send(token, conv.id, { text: 'Yeni mesaj' });
    const job = await ctx.db.one(
      "SELECT payload FROM jobs WHERE queue = 'ai' AND name = 'chatSummary' ORDER BY id DESC LIMIT 1",
    );
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    expect(payload).toEqual({ userId, conversationId: conv.id });

    ctx.openai.respond(() => ({
      model: 'test-chat-model',
      choices: [{ message: { content: 'Kullanıcı su içmeyi unutuyor.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 20 },
    }));
    const jobs = aiJobs({
      db: ctx.db,
      storage: ctx.storage,
      config: ctx.config,
      logger: silent,
      ai: ctx.ai,
      chat: ctx.chat,
      crypto: ctx.crypto,
    });
    await jobs.chatSummary({ payload });
    const summaryCall = ctx.openai.calls.at(-1);
    expect(summaryCall.stream).toBeUndefined();
    expect(summaryCall.messages[1].content).toContain('user mesaj 0');
    expect(summaryCall.messages[1].content).not.toContain('Yeni mesaj');

    ctx.openai.respond(() => openAiChunks(['Peki']));
    await send(token, conv.id, { text: 'Devam' });
    const next = ctx.openai.calls.at(-1);
    expect(next.messages[1]).toEqual({
      role: 'system',
      content: 'Summary of the earlier part of this conversation:\nKullanıcı su içmeyi unutuyor.',
    });
    expect(next.messages.length).toBeLessThanOrEqual(2 + 30 + 1);
  });
});
