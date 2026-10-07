#!/usr/bin/env bash
# Geri yükleme tatbikatı (F11, kabul: RTO < 2 sa). En son (ya da verilen) yedeği indirir, çözer,
# AYRI bir veritabanına yükler, kişisel verileri maskeler, sayım ve migration kontrolü yapar,
# süreyi yazar. Üretim veritabanına ASLA yüklemez (hedef ad zorunlu, üretim adıyla aynıysa durur).
#
#   scripts/restore-drill.sh <hedef_db> [db/2026/10/07/1215.sql.gz.enc]
#
# Hedef sunucu bilgileri: RESTORE_DB_HOST/PORT/USER/PASSWORD (deploy/backup.env), yoksa .env'deki.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=/dev/null
set -a; . ./.env; . deploy/backup.env; set +a
TARGET=${1:?Kullanım: scripts/restore-drill.sh <hedef_db> [yedek_yolu]}
[[ "$TARGET" != "$DB_NAME" ]] || { echo "✖ hedef üretim veritabanı olamaz" >&2; exit 1; }
BACKUP_STORAGE_HOST=${BACKUP_STORAGE_HOST:-storage.bunnycdn.com}
api="https://${BACKUP_STORAGE_HOST}/${BACKUP_STORAGE_ZONE}"
list() { curl -fsS -H "AccessKey: ${BACKUP_STORAGE_PASSWORD}" -H 'Accept: application/json' "$api/$1/" \
  | grep -o '"ObjectName":"[^"]*"' | cut -d'"' -f4 | sort | tail -1; }

started=$(date +%s)
NAME=${2:-}
if [[ -z "$NAME" ]]; then
  y=$(list db); m=$(list "db/$y"); d=$(list "db/$y/$m"); f=$(list "db/$y/$m/$d")
  NAME="db/$y/$m/$d/$f"
fi
echo "▶ yedek: $NAME → $TARGET"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/my.cnf" <<CNF
[client]
host=${RESTORE_DB_HOST:-$DB_HOST}
port=${RESTORE_DB_PORT:-${DB_PORT:-3306}}
user=${RESTORE_DB_USER:-$DB_USER}
password=${RESTORE_DB_PASSWORD:-$DB_PASSWORD}
CNF
chmod 600 "$TMP/my.cnf"
sql() { mysql --defaults-extra-file="$TMP/my.cnf" "$@"; }

curl -fsS -H "AccessKey: ${BACKUP_STORAGE_PASSWORD}" "$api/$NAME" -o "$TMP/dump.enc"
sql -e "CREATE DATABASE IF NOT EXISTS \`$TARGET\` CHARACTER SET utf8mb4"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE < "$TMP/dump.enc" \
  | gunzip | sql "$TARGET"
loaded=$(date +%s)

# Maskeleme (staging'de kullanılacaksa): kimlik/iletişim bilgisi ve cihaz token'ları.
sql "$TARGET" <<'SQL'
UPDATE users SET email = CONCAT('user-', LOWER(HEX(id)), '@example.invalid'), display_name = NULL
 WHERE email IS NOT NULL OR display_name IS NOT NULL;
UPDATE auth_identities SET email = NULL;
UPDATE devices SET push_token = NULL;
UPDATE sessions SET revoked_at = NOW(3), revoke_reason = 'admin' WHERE revoked_at IS NULL;
UPDATE user_consents SET ip = NULL;
UPDATE audit_logs SET ip = NULL, user_agent = NULL;
DELETE FROM admin_users;
SQL

echo "▶ sayımlar"
sql -N "$TARGET" -e "SELECT 'users', COUNT(*) FROM users UNION ALL SELECT 'fasting_sessions', COUNT(*) FROM fasting_sessions UNION ALL SELECT 'meals', COUNT(*) FROM meals UNION ALL SELECT 'schema_migrations', COUNT(*) FROM schema_migrations UNION ALL SELECT 'son_migration', MAX(version) FROM schema_migrations"
echo "✔ yükleme $(( loaded - started )) sn, toplam $(( $(date +%s) - started )) sn (RTO hedefi < 7200 sn)"
echo "  Sonucu docs/runbooks.md 'Geri yükleme tatbikatı' kaydına yaz."
