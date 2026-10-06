import { newId, toBin } from '../../shared/ids.js';

/**
 * Denetim kaydı yazar (docs/backend/06-guvenlik.md §8). Mümkünse işlemle AYNI transaction'da
 * (`conn`) çağrılır: işlem geri alınırsa kaydı da geri alınır.
 * `metadata` PII içermez (e-posta, isim, token yok).
 */
export async function writeAudit(db, entry, conn) {
  await db.run(
    `INSERT INTO audit_logs
       (id, actor_type, actor_id, action, entity_type, entity_id, ip, user_agent, metadata)
     VALUES (:id, :actorType, :actorId, :action, :entityType, :entityId,
             INET6_ATON(:ip), :userAgent, :metadata)`,
    {
      id: toBin(newId()),
      actorType: entry.actorType,
      actorId: entry.actorId ? toBin(entry.actorId) : null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    },
    conn,
  );
}
