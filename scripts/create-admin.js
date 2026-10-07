import '../src/config/env-file.js';
import { loadConfig } from '../src/config/index.js';
import { createCache } from '../src/infra/cache.js';
import { createFieldCrypto } from '../src/infra/crypto.js';
import { createDatabase } from '../src/infra/db.js';
import { createAdminAuth } from '../src/modules/admin/admin.auth.js';
import { ADMIN_ROLES } from '../src/modules/admin/admin.permissions.js';
import { findByEmail } from '../src/modules/admin/admin.repository.js';

/**
 * Yönetici hesabı oluşturur ya da kimlik bilgilerini sıfırlar (ilk owner, kilitlenen hesap).
 * Geçici şifre ve TOTP sırrı YALNIZCA bir kez ekrana yazılır; authenticator uygulamasına
 * ekleyip girişten sonra şifreyi değiştirin (POST /v1/admin/auth/password).
 *
 *   npm run admin:create -- <email> [owner|editor|support|analyst]
 *   npm run admin:create -- <email> --reset
 */
const [email, arg = 'owner'] = process.argv.slice(2);
const reset = arg === '--reset';
if (!email || (!reset && !ADMIN_ROLES.includes(arg))) {
  console.error(`Kullanım: npm run admin:create -- <email> [${ADMIN_ROLES.join('|')}|--reset]`);
  process.exit(1);
}

const config = loadConfig();
const db = createDatabase(config.db);
const auth = createAdminAuth({
  db,
  cache: createCache(),
  tokens: null,
  crypto: createFieldCrypto(config.fieldEncryption),
  config,
});
const meta = { ip: null, userAgent: 'scripts/create-admin' };
try {
  let result;
  if (reset) {
    const existing = await findByEmail(db, email);
    if (!existing) throw new Error(`yönetici yok: ${email}`);
    result = await auth.resetCredentials(existing.id, meta, null);
  } else {
    result = await auth.createAdmin({ email, role: arg }, meta, null);
  }
  console.log(`✔ ${result.admin.email} (${result.admin.role})`);
  console.log(`  Geçici şifre : ${result.password}`);
  console.log(`  TOTP sırrı   : ${result.totp.secret}`);
  console.log(`  otpauth URL  : ${result.totp.otpauthUrl}`);
  console.log('  Bu bilgiler bir daha gösterilmez.');
} catch (err) {
  console.error('✖ yönetici oluşturulamadı:', err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
