import { fromBin, toBin } from '../../shared/ids.js';

const CONV_COLUMNS = `id, user_id, title, is_pinned, message_count, rolling_summary_enc,
                      summary_upto_message_id, summary_message_count, context_source, context_ref,
                      last_message_at, created_at`;

function toConversation(r) {
  return (
    r && {
      id: fromBin(r.id),
      userId: fromBin(r.user_id),
      title: r.title ?? null,
      isPinned: Boolean(r.is_pinned),
      messageCount: r.message_count,
      summaryEnc: r.rolling_summary_enc ?? null,
      summaryUptoId: r.summary_upto_message_id ? fromBin(r.summary_upto_message_id) : null,
      summaryMessageCount: r.summary_message_count,
      contextSource: r.context_source,
      contextRef: r.context_ref ? fromBin(r.context_ref) : null,
      lastMessageAt: r.last_message_at ?? null,
      createdAt: r.created_at,
    }
  );
}

const MSG_COLUMNS = `id, conversation_id, user_id, role, content_enc, context_enc, status, safety,
                     model, input_tokens, output_tokens, cache_read_tokens, stop_reason, feedback,
                     created_at`;

function toMessage(r) {
  return (
    r && {
      id: fromBin(r.id),
      conversationId: fromBin(r.conversation_id),
      userId: fromBin(r.user_id),
      role: r.role,
      contentEnc: r.content_enc,
      contextEnc: r.context_enc ?? null,
      status: r.status,
      safety: r.safety,
      model: r.model ?? null,
      stopReason: r.stop_reason ?? null,
      feedback: r.feedback ?? null,
      createdAt: r.created_at,
    }
  );
}

export async function findConversation(db, userId, id, conn) {
  const c = toConversation(
    await db.one(
      `SELECT ${CONV_COLUMNS} FROM chat_conversations WHERE id = :id AND deleted_at IS NULL`,
      { id: toBin(id) },
      conn,
    ),
  );
  return c && c.userId === userId ? c : null;
}

export async function insertConversation(db, c) {
  await db.run(
    `INSERT INTO chat_conversations (id, user_id, context_source, context_ref)
     VALUES (:id, :userId, :source, :ref)`,
    {
      id: toBin(c.id),
      userId: toBin(c.userId),
      source: c.contextSource,
      ref: c.contextRef ? toBin(c.contextRef) : null,
    },
  );
}

export async function updateConversation(db, id, { isPinned, title }) {
  await db.run(
    `UPDATE chat_conversations
        SET is_pinned = COALESCE(:pinned, is_pinned), title = COALESCE(:title, title)
      WHERE id = :id`,
    {
      id: toBin(id),
      pinned: isPinned === undefined ? null : Number(isPinned),
      title: title ?? null,
    },
  );
}

export async function softDeleteConversation(db, id) {
  await db.run('UPDATE chat_conversations SET deleted_at = NOW(3) WHERE id = :id', {
    id: toBin(id),
  });
}

/** Sabitlenenler (ilk sayfada) + son mesaja göre azalan; imleç (last_message_at, id). */
export async function listConversations(db, userId, { pinned, before, limit }) {
  const rows = await db.many(
    `SELECT ${CONV_COLUMNS} FROM chat_conversations
      WHERE user_id = :userId AND deleted_at IS NULL AND is_pinned = :pinned
        AND (:beforeAt IS NULL
             OR COALESCE(last_message_at, created_at) < :beforeAt
             OR (COALESCE(last_message_at, created_at) = :beforeAt AND id < :beforeId))
      ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC
      LIMIT :limit`,
    {
      userId: toBin(userId),
      pinned: pinned ? 1 : 0,
      beforeAt: before?.at ?? null,
      beforeId: before ? toBin(before.id) : null,
      limit: String(limit + 1),
    },
  );
  return rows.map(toConversation);
}

export async function findMessage(db, id, conn) {
  return toMessage(
    await db.one(
      `SELECT ${MSG_COLUMNS} FROM chat_messages WHERE id = :id`,
      { id: toBin(id) },
      conn,
    ),
  );
}

export async function insertMessage(db, m, conn) {
  await db.run(
    `INSERT INTO chat_messages
       (id, conversation_id, user_id, role, content_enc, context_enc, status, safety, created_at)
     VALUES (:id, :conv, :userId, :role, :content, :context, :status, :safety, :createdAt)`,
    {
      id: toBin(m.id),
      conv: toBin(m.conversationId),
      userId: toBin(m.userId),
      role: m.role,
      content: m.contentEnc,
      context: m.contextEnc ?? null,
      status: m.status,
      safety: m.safety ?? 'none',
      createdAt: m.createdAt,
    },
    conn,
  );
}

export async function finishMessage(db, id, f) {
  await db.run(
    `UPDATE chat_messages
        SET content_enc = :content, status = :status, model = :model, input_tokens = :input,
            output_tokens = :output, cache_read_tokens = :cacheRead, stop_reason = :stopReason
      WHERE id = :id`,
    {
      id: toBin(id),
      content: f.contentEnc,
      status: f.status,
      model: f.model ?? null,
      input: f.inputTokens ?? null,
      output: f.outputTokens ?? null,
      cacheRead: f.cacheReadTokens ?? null,
      stopReason: f.stopReason ?? null,
    },
  );
}

/** Yeni mesaj sonrası sayaç, son mesaj zamanı ve (yoksa) başlık. */
export async function touchConversation(db, id, { added, title }, conn) {
  await db.run(
    `UPDATE chat_conversations
        SET message_count = message_count + :added, last_message_at = NOW(3),
            title = COALESCE(title, :title)
      WHERE id = :id`,
    { id: toBin(id), added, title: title ?? null },
    conn,
  );
}

/** Eskiden yeniye sayfa: imleç daha eski mesajları getirir. */
export async function listMessages(db, conversationId, { before, limit }) {
  const rows = await db.many(
    `SELECT ${MSG_COLUMNS} FROM chat_messages
      WHERE conversation_id = :conv
        AND (:beforeAt IS NULL OR created_at < :beforeAt
             OR (created_at = :beforeAt AND id < :beforeId))
      ORDER BY created_at DESC, id DESC
      LIMIT :limit`,
    {
      conv: toBin(conversationId),
      beforeAt: before?.at ?? null,
      beforeId: before ? toBin(before.id) : null,
      limit: String(limit + 1),
    },
  );
  return rows.map(toMessage);
}

/**
 * Modele gidecek geçmiş: özetin kapsadığı mesajlardan sonrası, son `limit` mesaj (eskiden yeniye).
 * Başarısız ve boş yanıtlar hariç.
 */
export async function historyFor(db, conversation, { limit, excludeIds = [] }) {
  const exclude = excludeIds.map((id, i) => [`x${i}`, toBin(id)]);
  const upto = conversation.summaryUptoId
    ? await db.one('SELECT created_at FROM chat_messages WHERE id = :id', {
        id: toBin(conversation.summaryUptoId),
      })
    : null;
  const rows = await db.many(
    `SELECT ${MSG_COLUMNS} FROM chat_messages
      WHERE conversation_id = :conv AND status IN ('complete', 'interrupted', 'refused')
        AND (:upto IS NULL OR created_at > :upto)
        ${exclude.length ? `AND id NOT IN (${exclude.map(([k]) => `:${k}`).join(', ')})` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT :limit`,
    {
      conv: toBin(conversation.id),
      upto: upto?.created_at ?? null,
      limit: String(limit),
      ...Object.fromEntries(exclude),
    },
  );
  return rows.map(toMessage).reverse();
}

/** Özetlenecek mesajlar: son `keep` mesaj hariç, önceki özetten sonrakiler (eskiden yeniye). */
export async function messagesToSummarize(db, conversation, { keep }) {
  const rows = await db.many(
    `SELECT ${MSG_COLUMNS} FROM chat_messages
      WHERE conversation_id = :conv AND status IN ('complete', 'interrupted')
      ORDER BY created_at DESC, id DESC`,
    { conv: toBin(conversation.id) },
  );
  const older = rows.slice(keep).map(toMessage).reverse();
  if (!conversation.summaryUptoId) return older;
  const idx = older.findIndex((m) => m.id === conversation.summaryUptoId);
  return idx >= 0 ? older.slice(idx + 1) : older;
}

export async function saveSummary(db, id, { summaryEnc, uptoId, messageCount }) {
  await db.run(
    `UPDATE chat_conversations
        SET rolling_summary_enc = :summary, summary_upto_message_id = :upto,
            summary_message_count = :count
      WHERE id = :id`,
    { id: toBin(id), summary: summaryEnc, upto: toBin(uptoId), count: messageCount },
  );
}

export async function setFeedback(db, id, { rating, reason }) {
  await db.run(
    'UPDATE chat_messages SET feedback = :rating, feedback_reason = :reason WHERE id = :id',
    { id: toBin(id), rating, reason: reason ?? null },
  );
}

/** Asistan yanıtı: bu kullanıcı mesajından sonra gelen ilk asistan mesajı (tekrar gönderim). */
export async function replyAfter(db, userMessage) {
  return toMessage(
    await db.one(
      `SELECT ${MSG_COLUMNS} FROM chat_messages
        WHERE conversation_id = :conv AND role = 'assistant'
          AND (created_at > :at OR (created_at = :at AND id > :id))
        ORDER BY created_at, id LIMIT 1`,
      {
        conv: toBin(userMessage.conversationId),
        at: userMessage.createdAt,
        id: toBin(userMessage.id),
      },
    ),
  );
}
