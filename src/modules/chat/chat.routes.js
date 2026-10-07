import { AppError } from '../../shared/errors.js';
import { memoizeByDeps } from '../../shared/legacy.js';
import { aiGateFor } from '../ai/ai.routes.js';
import { quotaSchema } from '../ai/ai.schemas.js';
import { contentServiceFor } from '../catalog/catalog.routes.js';
import { fastingServiceFor } from '../fasting/fasting.routes.js';
import { plansServiceFor } from '../plans/plans.routes.js';
import { statsServiceFor } from '../stats/stats.routes.js';
import { createContextLoader } from './chat.context.js';
import { createChatService } from './chat.service.js';
import * as s from './chat.schemas.js';

export const chatServiceFor = memoizeByDeps((app) =>
  createChatService({
    db: app.deps.db,
    crypto: app.deps.crypto,
    chat: app.deps.chat,
    gate: aiGateFor(app),
    contexts: createContextLoader({
      db: app.deps.db,
      fasting: fastingServiceFor(app),
      plans: plansServiceFor(app),
      stats: statsServiceFor(app),
    }),
    content: contentServiceFor(app),
    jobs: app.deps.jobs,
    logger: app.log,
  }),
);

const HEARTBEAT_MS = 15_000;

/** SSE yazıcısı: bağlantı kapandıysa yazmaz. */
function sseSink(reply, signal) {
  const res = reply.raw;
  return {
    signal,
    event(name, data) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    },
    comment(text) {
      if (!res.writableEnded && !res.destroyed) res.write(`: ${text}\n\n`);
    },
  };
}

/** `/v1/chat` (docs/backend/04-api.md §14, 09-yapay-zeka.md §2). */
export default async function chatRoutes(app) {
  const chat = chatServiceFor(app);
  const gate = aiGateFor(app);
  const auth = { preHandler: app.requireAuth };

  app.get('/quota', { ...auth, schema: quotaSchema }, (request) => gate.status(request.user.id));
  app.get('/suggestions', { ...auth, schema: s.suggestionsSchema }, (request) =>
    chat.suggestions(request.ctx.locale),
  );
  app.get('/conversations', { ...auth, schema: s.listSchema }, (request) =>
    chat.list(request.user.id, request.query),
  );
  app.post('/conversations', { ...auth, schema: s.createSchema }, async (request, reply) => {
    reply.code(201);
    return chat.create(request.user.id, request.body ?? {});
  });
  app.patch('/conversations/:id', { ...auth, schema: s.updateSchema }, (request) =>
    chat.update(request.user.id, request.params.id, request.body),
  );
  app.delete('/conversations/:id', { ...auth, schema: s.deleteSchema }, (request) =>
    chat.remove(request.user.id, request.params.id),
  );
  app.get('/conversations/:id/messages', { ...auth, schema: s.messagesSchema }, (request) =>
    chat.messages(request.user.id, request.params.id, request.query),
  );
  app.post('/messages/:id/feedback', { ...auth, schema: s.feedbackSchema }, (request) =>
    chat.feedback(request.user.id, request.params.id, request.body),
  );

  /**
   * Mesaj gönder. Doğrulama/kota/kilit hataları akış açılmadan normal JSON hatasıdır.
   * SSE: `message.created` → `delta`… → `message.completed` | `error`; 15 sn'de bir `: ping`.
   * İstemci bağlantıyı koparırsa model çağrısı iptal edilir (maliyet durur).
   */
  app.post(
    '/conversations/:id/messages',
    // 06 §7: kullanıcı başına dakikada 20 mesaj (kota ayrıca günlük).
    { ...auth, schema: s.sendSchema, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const turn = await chat.prepare(
        request.user.id,
        request.params.id,
        request.body,
        request.ctx.locale,
      );

      if (!(request.headers.accept ?? '').includes('text/event-stream')) {
        // Yedek yol: akışsız tam yanıt.
        const events = [];
        await chat.stream(turn, { event: (name, data) => events.push({ name, data }) });
        const error = events.find((e) => e.name === 'error');
        if (error) throw new AppError('UNAVAILABLE', { details: { reason: error.data.reason } });
        const created = events.find((e) => e.name === 'message.created')?.data;
        const completed = events.find((e) => e.name === 'message.completed')?.data;
        const message = completed
          ? await chat.getMessage(request.user.id, completed.assistantMessageId)
          : null;
        return {
          userMessageId: created?.userMessageId,
          assistantMessage: message,
          remainingToday: completed?.usage?.remainingToday ?? null,
        };
      }

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx'in yanıtı tamponlamaması için (deploy/nginx).
        'x-accel-buffering': 'no',
        'x-request-id': request.id,
      });
      const closed = new AbortController();
      res.on('close', () => closed.abort());
      const sink = sseSink(reply, closed.signal);
      const heartbeat = setInterval(() => sink.comment('ping'), HEARTBEAT_MS);
      try {
        await chat.stream(turn, sink);
      } catch (err) {
        request.log.error({ err }, 'sohbet akışı hatası');
        sink.event('error', { code: 'INTERNAL' });
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    },
  );
}
