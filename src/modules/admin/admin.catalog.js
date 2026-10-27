import { AppError } from '../../shared/errors.js';
import {
  currentDocument,
  documentVersion,
  listVersions,
  saveDocument,
} from '../catalog/catalog.documents.js';
import { CATALOG_SECTIONS, bumpCatalogVersion } from '../catalog/catalog.seeder.js';
import { resetTemplateCache } from '../notifications/notifications.repository.js';

/** Panelden değiştirilemeyen yapılandırma anahtarları (sistem yönetir). */
const PROTECTED_CONFIG_KEYS = new Set(['catalog.version']);
const CONFIG_CACHE_KEY = 'cfg:app:rows';

const metaDto = (m) => ({
  version: m.version,
  source: m.source,
  adminId: m.adminId,
  note: m.note,
  createdAt: m.createdAt.toISOString(),
});

function invalidDocument(err) {
  return new AppError('VALIDATION_FAILED', {
    cause: err,
    details: { reason: 'invalid_document', message: String(err?.message ?? err).slice(0, 300) },
  });
}

/**
 * İçerik (katalog bölümleri) ve uygulama yapılandırması yönetimi (04 §19).
 *
 * İçerik, seed dosyalarıyla aynı biçimde bölüm bazında düzenlenir: plans, labels, content
 * (evreler, struggle, insights, FAQ, öneriler), gamification (challenge'lar, bölgeler),
 * notifications (şablonlar). Kayıt, seed'in kullandığı fonksiyonla tek transaction'da yazılır;
 * hata olursa hiçbir şey değişmez. Panelden kaydedilen bölümü `npm run seed` artık ezmez.
 */
export function createAdminCatalog({ db, cache, audit }) {
  function sectionSpec(section) {
    const spec = CATALOG_SECTIONS[section];
    if (!spec) throw new AppError('NOT_FOUND');
    return spec;
  }

  async function apply(section, document, { adminId, note, baseVersion }, meta, action) {
    const spec = sectionSpec(section);
    const isArray = Array.isArray(document);
    if ((spec.kind === 'array') !== isArray || document === null || typeof document !== 'object') {
      throw invalidDocument(
        new Error(`document must be ${spec.kind === 'array' ? 'an array' : 'an object'}`),
      );
    }
    const result = await db
      .withTransaction(async (conn) => {
        const current = await currentDocument(db, section, conn);
        if (baseVersion !== undefined && (current?.version ?? 0) !== baseVersion) {
          throw new AppError('CONFLICT', {
            details: { reason: 'stale_version', currentVersion: current?.version ?? 0 },
          });
        }
        const stats = await spec.apply(db, conn, document);
        const version = await saveDocument(db, conn, {
          section,
          document,
          source: 'admin',
          adminId,
          note,
        });
        const catalogVersion = await bumpCatalogVersion(db, conn);
        return { version, catalogVersion, stats };
      })
      .catch((err) => {
        if (err instanceof AppError) throw err;
        // Seed fonksiyonundan gelen hata (eksik alan, kısıt ihlali…) → 400.
        throw invalidDocument(err);
      });
    await cache.del(CONFIG_CACHE_KEY);
    if (section === 'notifications') resetTemplateCache();
    // Challenge tanımları 60 sn bellekte (challenges.service.js); değişiklik hemen görünsün.
    await cache.delPrefix('challenges:catalog:');
    await audit(meta, action, adminId, {
      entityType: 'catalog_section',
      entityId: section,
      metadata: { version: result.version, catalogVersion: result.catalogVersion },
    });
    return result;
  }

  return {
    async listSections() {
      const items = [];
      for (const section of Object.keys(CATALOG_SECTIONS)) {
        const current = await currentDocument(db, section);
        items.push({ section, current: current ? metaDto(current) : null });
      }
      return { items };
    },

    async getSection(section) {
      sectionSpec(section);
      const current = await currentDocument(db, section, undefined, { withDocument: true });
      if (!current) throw new AppError('NOT_FOUND');
      return { section, ...metaDto(current), document: current.document };
    },

    async listVersions(section) {
      sectionSpec(section);
      return { items: (await listVersions(db, section)).map(metaDto) };
    },

    async getVersion(section, version) {
      sectionSpec(section);
      const doc = await documentVersion(db, section, version);
      if (!doc) throw new AppError('NOT_FOUND');
      return { section, ...metaDto(doc), document: doc.document };
    },

    /** `baseVersion`: düzenlemenin başladığı sürüm; arada başkası kaydettiyse 409. */
    async saveSection(section, { document, baseVersion, note }, meta, adminId) {
      return apply(section, document, { adminId, note, baseVersion }, meta, 'admin.catalog.update');
    },

    /** Eski bir sürümü yeni sürüm olarak yeniden uygular. */
    async rollback(section, { version, note }, meta, adminId) {
      sectionSpec(section);
      const doc = await documentVersion(db, section, version);
      if (!doc) throw new AppError('NOT_FOUND');
      return apply(
        section,
        doc.document,
        { adminId, note: note ?? `rollback to v${version}` },
        meta,
        'admin.catalog.rollback',
      );
    },

    // ── app_config ─────────────────────────────────────────────────────
    async listConfig() {
      const rows = await db.many(
        `SELECT config_key, platform, CAST(value AS CHAR) AS value, description, updated_at
           FROM app_config ORDER BY config_key, platform`,
      );
      return {
        items: rows.map((r) => ({
          key: r.config_key,
          platform: r.platform,
          value: JSON.parse(r.value),
          description: r.description ?? null,
          protected: PROTECTED_CONFIG_KEYS.has(r.config_key),
          updatedAt: r.updated_at.toISOString(),
        })),
      };
    },

    async setConfig(key, { platform = 'all', value, description }, meta, adminId) {
      if (PROTECTED_CONFIG_KEYS.has(key)) {
        throw new AppError('FORBIDDEN', { details: { reason: 'protected_key' } });
      }
      await db.run(
        `INSERT INTO app_config (config_key, platform, value, description)
         VALUES (:key, :platform, :value, :description)
         ON DUPLICATE KEY UPDATE value = VALUES(value),
                                 description = COALESCE(VALUES(description), description)`,
        { key, platform, value: JSON.stringify(value), description: description ?? null },
      );
      await cache.del(CONFIG_CACHE_KEY);
      await audit(meta, 'admin.config.update', adminId, {
        entityType: 'app_config',
        entityId: `${key}:${platform}`,
        metadata: { value },
      });
      return this.listConfig();
    },

    /** Platforma özel değeri kaldırır ('all' değeri silinemez). */
    async deleteConfig(key, platform, meta, adminId) {
      if (platform === 'all' || PROTECTED_CONFIG_KEYS.has(key)) {
        throw new AppError('FORBIDDEN', { details: { reason: 'protected_key' } });
      }
      const r = await db.run(
        'DELETE FROM app_config WHERE config_key = :key AND platform = :platform',
        { key, platform },
      );
      if (r.affectedRows === 0) throw new AppError('NOT_FOUND');
      await cache.del(CONFIG_CACHE_KEY);
      await audit(meta, 'admin.config.delete', adminId, {
        entityType: 'app_config',
        entityId: `${key}:${platform}`,
      });
      return {};
    },
  };
}
