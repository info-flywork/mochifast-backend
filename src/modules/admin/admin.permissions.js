/**
 * Yönetici rolleri ve izinleri (06 §3, §12). İzinler route seviyesinde deklaratif verilir:
 * `preHandler: app.requireAdmin('catalog.write')`.
 *
 * - owner   : her şey (yönetici hesapları dahil)
 * - editor  : içerik, uygulama yapılandırması, public medya
 * - support : kullanıcı arama (maskeli) ve destek işlemleri
 * - analyst : salt-okunur raporlar
 */
export const ADMIN_ROLES = Object.freeze(['owner', 'editor', 'support', 'analyst']);

export const PERMISSIONS = Object.freeze({
  'admins.manage': ['owner'],
  'catalog.read': ['owner', 'editor'],
  'catalog.write': ['owner', 'editor'],
  'config.read': ['owner', 'editor'],
  'config.write': ['owner', 'editor'],
  'media.upload': ['owner', 'editor'],
  'users.read': ['owner', 'support'],
  'users.act': ['owner', 'support'],
  'reports.read': ['owner', 'analyst'],
});

export function can(role, permission) {
  const roles = PERMISSIONS[permission];
  if (!roles) throw new Error(`bilinmeyen izin: ${permission}`);
  return roles.includes(role);
}

/** a***@g***.com — destek rolü PII'yi maskeli görür (06 §12). */
export function maskEmail(email) {
  if (!email) return null;
  const [local, domain = ''] = String(email).split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
}

/** "Ayşe Yılmaz" → "A*** Y***" */
export function maskName(name) {
  if (!name) return null;
  return String(name)
    .trim()
    .split(/\s+/)
    .map((part) => `${[...part][0] ?? ''}***`)
    .join(' ');
}
