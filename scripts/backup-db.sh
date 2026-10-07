#!/usr/bin/env bash
# Veritabanı yedeği (F11): mysqldump → gzip → AES-256 (openssl, PBKDF2) → Bunny storage (ayrı,
# pull zone'a BAĞLI OLMAYAN zone; yani internetten okunamaz) → eski yedekleri sil.
# Sunucuda cron ile (saatlik):
#   15 * * * * cd /path/mochifast-backend && scripts/backup-db.sh >> logs/backup.log 2>&1
#
# Ayarlar: deploy/backup.env (deploy/backup.env.example) + DB bilgileri .env'den.
# cPanel MariaDB'de PITR (binlog) yok: RPO = yedek aralığı (saatlik → ≤ 1 sa). docs/runbooks.md
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=/dev/null
set -a; . ./.env; . deploy/backup.env; set +a
: "${BACKUP_PASSPHRASE:?deploy/backup.env içinde BACKUP_PASSPHRASE yok}"
: "${BACKUP_STORAGE_ZONE:?}" "${BACKUP_STORAGE_PASSWORD:?}"
BACKUP_STORAGE_HOST=${BACKUP_STORAGE_HOST:-storage.bunnycdn.com}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}

STAMP=$(date -u +%Y/%m/%d/%H%M)
NAME="db/${STAMP}.sql.gz.enc"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

started=$(date +%s)
# Şifre komut satırında görünmesin: geçici my.cnf
cat > "$TMP/my.cnf" <<CNF
[client]
host=${DB_HOST}
port=${DB_PORT:-3306}
user=${DB_USER}
password=${DB_PASSWORD}
CNF
chmod 600 "$TMP/my.cnf"

mysqldump --defaults-extra-file="$TMP/my.cnf" --single-transaction --quick --routines --triggers \
  --default-character-set=utf8mb4 --hex-blob --no-tablespaces "$DB_NAME" \
  | gzip -6 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE \
  > "$TMP/dump.enc"

bytes=$(wc -c < "$TMP/dump.enc" | tr -d ' ')
[[ "$bytes" -gt 1024 ]] || { echo "✖ yedek çok küçük ($bytes bayt)" >&2; exit 1; }
sha=$(shasum -a 256 "$TMP/dump.enc" | cut -d' ' -f1 | tr 'a-f' 'A-F')

curl -fsS -X PUT --data-binary @"$TMP/dump.enc" \
  -H "AccessKey: ${BACKUP_STORAGE_PASSWORD}" -H "Checksum: ${sha}" \
  "https://${BACKUP_STORAGE_HOST}/${BACKUP_STORAGE_ZONE}/${NAME}" > /dev/null

echo "✔ $(date -u +%FT%TZ) ${NAME} ${bytes} bayt $(( $(date +%s) - started )) sn"

# Saklama: BACKUP_RETENTION_DAYS günden eski gün klasörleri silinir (günde bir, 03:xx'te).
if [[ $(date -u +%H) == 03 ]]; then
  cutoff=$(date -u -d "-${BACKUP_RETENTION_DAYS} days" +%Y%m%d 2>/dev/null || date -u -v-"${BACKUP_RETENTION_DAYS}"d +%Y%m%d)
  list() { curl -fsS -H "AccessKey: ${BACKUP_STORAGE_PASSWORD}" -H 'Accept: application/json' \
    "https://${BACKUP_STORAGE_HOST}/${BACKUP_STORAGE_ZONE}/$1/" | grep -o '"ObjectName":"[^"]*"' | cut -d'"' -f4; }
  for y in $(list db); do for m in $(list "db/$y"); do for d in $(list "db/$y/$m"); do
    if [[ "$y$m$d" < "$cutoff" ]]; then
      curl -fsS -X DELETE -H "AccessKey: ${BACKUP_STORAGE_PASSWORD}" \
        "https://${BACKUP_STORAGE_HOST}/${BACKUP_STORAGE_ZONE}/db/$y/$m/$d/" > /dev/null
      echo "  · silindi db/$y/$m/$d"
    fi
  done; done; done
fi
