import { fromBin, newId, toBin } from '../../shared/ids.js';

const COLUMNS = `id, email, password_hash, role, totp_secret_enc, totp_last_step, failed_attempts,
                 locked_until, is_active, last_login_at, created_at`;

const toAdmin = (r) =>
  r && {
    id: fromBin(r.id),
    email: r.email,
    passwordHash: r.password_hash,
    role: r.role,
    totpSecretEnc: r.totp_secret_enc,
    totpLastStep: r.totp_last_step === null ? null : Number(r.totp_last_step),
    failedAttempts: r.failed_attempts,
    lockedUntil: r.locked_until ?? null,
    isActive: Boolean(r.is_active),
    lastLoginAt: r.last_login_at ?? null,
    createdAt: r.created_at,
  };

export async function findByEmail(db, email, conn) {
  return toAdmin(
    await db.one(
      `SELECT ${COLUMNS} FROM admin_users WHERE email = :email ${conn ? 'FOR UPDATE' : ''}`,
      { email: email.trim().toLowerCase() },
      conn,
    ),
  );
}

export async function findById(db, id) {
  return toAdmin(
    await db.one(`SELECT ${COLUMNS} FROM admin_users WHERE id = :id`, { id: toBin(id) }),
  );
}

export async function list(db) {
  return (await db.many(`SELECT ${COLUMNS} FROM admin_users ORDER BY created_at`)).map(toAdmin);
}

export async function insert(db, { id = newId(), email, passwordHash, role, totpSecretEnc }) {
  await db.run(
    `INSERT INTO admin_users (id, email, password_hash, role, totp_secret_enc)
     VALUES (:id, :email, :passwordHash, :role, :totpSecretEnc)`,
    { id: toBin(id), email: email.trim().toLowerCase(), passwordHash, role, totpSecretEnc },
  );
  return id;
}

export async function update(db, id, fields, conn) {
  const map = {
    role: 'role',
    isActive: 'is_active',
    passwordHash: 'password_hash',
    totpSecretEnc: 'totp_secret_enc',
    totpLastStep: 'totp_last_step',
    failedAttempts: 'failed_attempts',
    lockedUntil: 'locked_until',
    lastLoginAt: 'last_login_at',
  };
  const sets = [];
  const params = { id: toBin(id) };
  for (const [key, column] of Object.entries(map)) {
    if (fields[key] === undefined) continue;
    sets.push(`${column} = :${key}`);
    params[key] = typeof fields[key] === 'boolean' ? Number(fields[key]) : fields[key];
  }
  if (sets.length === 0) return;
  await db.run(`UPDATE admin_users SET ${sets.join(', ')} WHERE id = :id`, params, conn);
}
