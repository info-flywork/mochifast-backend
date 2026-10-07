import { toDbEnum } from '../../shared/enums.js';
import { accountServiceFor } from '../account/account.routes.js';
import { memoizeByDeps } from '../../shared/legacy.js';
import { billingServiceFor } from '../billing/billing.routes.js';
import { mediaServiceFor, readUpload, uploadRateLimit } from '../media/media.routes.js';
import { createAdminAuth } from './admin.auth.js';
import { createAdminCatalog } from './admin.catalog.js';
import { createAdminReports } from './admin.reports.js';
import * as s from './admin.schemas.js';
import { createAdminSupport } from './admin.support.js';

export const adminAuthFor = memoizeByDeps((app) =>
  createAdminAuth({
    db: app.deps.db,
    cache: app.deps.cache,
    tokens: app.deps.tokens,
    crypto: app.deps.crypto,
    config: app.config,
    logger: app.log,
  }),
);

const meta = (r) => ({ ip: r.ip, userAgent: r.headers['user-agent'] });

/** Katalog bölüm dokümanları büyük olabilir (içerik ~150 KB). */
const CATALOG_BODY_LIMIT = 2 * 1024 * 1024;

/**
 * `/v1/admin` (docs/backend/04-api.md §19, 06 §12). Her uç IP kısıtından geçer; giriş dışındaki
 * uçlar yönetici token'ı ve izin ister. Tüm işlemler `audit_logs`'a yazılır.
 */
export default async function adminRoutes(app) {
  const auth = adminAuthFor(app);
  const catalog = createAdminCatalog({ db: app.deps.db, cache: app.deps.cache, audit: auth.audit });
  const support = createAdminSupport({
    db: app.deps.db,
    cache: app.deps.cache,
    entitlements: app.deps.entitlements,
    billing: billingServiceFor(app),
    account: accountServiceFor(app),
    audit: auth.audit,
  });
  const reports = createAdminReports({ db: app.deps.db });
  const media = mediaServiceFor(app);
  const need = (permission) => ({ preHandler: auth.guard(permission) });
  const actor = (request) => request.admin.id;

  // ── Kimlik ──
  app.post('/auth/login', { ...need(null), schema: s.loginSchema }, (request) =>
    auth.login(request.body, meta(request)),
  );
  app.get('/auth/me', { ...need('self'), schema: s.meSchema }, (request) =>
    auth.me(actor(request)),
  );
  app.post('/auth/password', { ...need('self'), schema: s.passwordSchema }, (request) =>
    auth.changePassword(actor(request), request.body, meta(request)),
  );
  app.post('/auth/logout', { ...need('self'), schema: s.logoutSchema }, (request) =>
    auth.logout(actor(request), meta(request)),
  );

  // ── Yöneticiler ──
  app.get('/admins', { ...need('admins.manage'), schema: s.listAdminsSchema }, () =>
    auth.listAdmins(),
  );
  app.post(
    '/admins',
    { ...need('admins.manage'), schema: s.createAdminSchema },
    async (request, reply) => {
      reply.code(201);
      return auth.createAdmin(request.body, meta(request), actor(request));
    },
  );
  app.patch('/admins/:id', { ...need('admins.manage'), schema: s.updateAdminSchema }, (request) =>
    auth.updateAdmin(request.params.id, request.body, meta(request), actor(request)),
  );
  app.post(
    '/admins/:id/reset-credentials',
    { ...need('admins.manage'), schema: s.resetAdminSchema },
    (request) => auth.resetCredentials(request.params.id, meta(request), actor(request)),
  );

  // ── Katalog (içerik) ──
  app.get('/catalog', { ...need('catalog.read'), schema: s.listSectionsSchema }, () =>
    catalog.listSections(),
  );
  app.get('/catalog/:section', { ...need('catalog.read'), schema: s.getSectionSchema }, (request) =>
    catalog.getSection(request.params.section),
  );
  app.get(
    '/catalog/:section/versions',
    { ...need('catalog.read'), schema: s.listVersionsSchema },
    (request) => catalog.listVersions(request.params.section),
  );
  app.get(
    '/catalog/:section/versions/:version',
    { ...need('catalog.read'), schema: s.getVersionSchema },
    (request) => catalog.getVersion(request.params.section, request.params.version),
  );
  app.put(
    '/catalog/:section',
    { ...need('catalog.write'), schema: s.saveSectionSchema, bodyLimit: CATALOG_BODY_LIMIT },
    (request) =>
      catalog.saveSection(request.params.section, request.body, meta(request), actor(request)),
  );
  app.post(
    '/catalog/:section/rollback',
    { ...need('catalog.write'), schema: s.rollbackSchema },
    (request) =>
      catalog.rollback(request.params.section, request.body, meta(request), actor(request)),
  );

  // ── app_config ──
  app.get('/config', { ...need('config.read'), schema: s.listConfigSchema }, () =>
    catalog.listConfig(),
  );
  app.put('/config/:key', { ...need('config.write'), schema: s.setConfigSchema }, (request) =>
    catalog.setConfig(request.params.key, request.body, meta(request), actor(request)),
  );
  app.delete('/config/:key', { ...need('config.write'), schema: s.deleteConfigSchema }, (request) =>
    catalog.deleteConfig(request.params.key, request.query.platform, meta(request), actor(request)),
  );

  // ── Medya (public içerik görselleri) ──
  app.post(
    '/media',
    { ...need('media.upload'), schema: s.uploadSchema, config: uploadRateLimit },
    async (request, reply) => {
      const purpose = toDbEnum(request.query.purpose);
      const result = await media.upload(null, purpose, await readUpload(request));
      await auth.audit(meta(request), 'admin.media.upload', actor(request), {
        entityType: 'media',
        entityId: result.media.id,
        metadata: { purpose },
      });
      reply.code(201);
      return { media: media.present(result.media) };
    },
  );

  // ── Kullanıcılar (destek) ──
  // Arama POST: e-posta URL'de (ve erişim loglarında) görünmez.
  app.post('/users/search', { ...need('users.read'), schema: s.searchUsersSchema }, (request) =>
    support.search(request.body.q, meta(request), actor(request)),
  );
  app.get('/users/:id', { ...need('users.read'), schema: s.userDetailSchema }, (request) =>
    support.detail(request.params.id, meta(request), actor(request)),
  );
  app.post(
    '/users/:id/sessions/revoke',
    { ...need('users.act'), schema: s.revokeSessionsSchema },
    (request) =>
      support.revokeSessions(request.params.id, request.body, meta(request), actor(request)),
  );
  app.post(
    '/users/:id/premium',
    { ...need('users.act'), schema: s.grantPremiumSchema },
    (request) =>
      support.grantPremium(request.params.id, request.body, meta(request), actor(request)),
  );
  app.post(
    '/users/:id/deletion',
    { ...need('users.act'), schema: s.requestDeletionSchema },
    async (request, reply) => {
      reply.code(202);
      return support.requestDeletion(
        request.params.id,
        request.body,
        meta(request),
        actor(request),
      );
    },
  );
  app.post(
    '/users/:id/deletion/expedite',
    { ...need('users.act'), schema: s.expediteDeletionSchema },
    (request) =>
      support.expediteDeletion(request.params.id, request.body, meta(request), actor(request)),
  );

  // ── Raporlar ──
  app.get('/reports/overview', { ...need('reports.read'), schema: s.overviewSchema }, (request) =>
    reports.overview(request.query),
  );
}
