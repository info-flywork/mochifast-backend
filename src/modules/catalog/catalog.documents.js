import { createHash } from 'node:crypto';
import { fromBin, toBin } from '../../shared/ids.js';

/**
 * Katalog dokümanları (seed biçimi, sürümlü): `npm run seed` ve yönetim paneli aynı tabloya
 * yazar. Bölümün son sürümü geçerlidir; eski sürümler geri alma için saklanır.
 */
const KEEP_VERSIONS = 30;

const sha = (text) => createHash('sha256').update(text).digest('hex');

const toMeta = (r) => ({
  version: r.version,
  source: r.source,
  adminId: r.admin_id ? fromBin(r.admin_id) : null,
  note: r.note ?? null,
  sha256: r.sha256,
  createdAt: r.created_at,
});

/** @returns {version, source, adminId, note, sha256, createdAt, document} ya da null */
export async function currentDocument(db, section, conn, { withDocument = false } = {}) {
  const row = await db.one(
    `SELECT version, source, admin_id, note, sha256, created_at
            ${withDocument ? ', document' : ''}
       FROM catalog_documents WHERE section = :section
      ORDER BY version DESC LIMIT 1`,
    { section },
    conn,
  );
  if (!row) return null;
  return { ...toMeta(row), ...(withDocument ? { document: JSON.parse(row.document) } : {}) };
}

export async function documentVersion(db, section, version) {
  const row = await db.one(
    `SELECT version, source, admin_id, note, sha256, created_at, document
       FROM catalog_documents WHERE section = :section AND version = :version`,
    { section, version },
  );
  return row ? { ...toMeta(row), document: JSON.parse(row.document) } : null;
}

export async function listVersions(db, section) {
  const rows = await db.many(
    `SELECT version, source, admin_id, note, sha256, created_at FROM catalog_documents
      WHERE section = :section ORDER BY version DESC`,
    { section },
  );
  return rows.map(toMeta);
}

/**
 * Yeni sürüm yazar; içerik son sürümle aynıysa (seed tekrarı) yazmaz.
 * @returns yazılan sürüm (ya da değişmeyen mevcut sürüm)
 */
export async function saveDocument(db, conn, { section, document, source, adminId, note }) {
  const text = JSON.stringify(document);
  const hash = sha(text);
  const current = await currentDocument(db, section, conn);
  if (current && current.sha256 === hash && current.source === source) return current.version;
  const version = (current?.version ?? 0) + 1;
  await db.run(
    `INSERT INTO catalog_documents (section, version, source, document, sha256, admin_id, note)
     VALUES (:section, :version, :source, :document, :sha256, :adminId, :note)`,
    {
      section,
      version,
      source,
      document: text,
      sha256: hash,
      adminId: adminId ? toBin(adminId) : null,
      note: note ?? null,
    },
    conn,
  );
  await db.run(
    'DELETE FROM catalog_documents WHERE section = :section AND version <= :oldest',
    { section, oldest: version - KEEP_VERSIONS },
    conn,
  );
  return version;
}
