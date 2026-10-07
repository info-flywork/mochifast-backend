#!/usr/bin/env bash
# Bilgisayarından sunucuya deploy. Ayarlar: deploy/deploy.env (deploy/deploy.env.example'dan kopyala).
#
#   npm run deploy                 kodu gönder + yayına al (sync + release)
#   npm run deploy -- sync         yalnızca kodu gönder
#   npm run deploy -- sync --env   kodu ve .env.production'ı (sunucuda .env olarak) gönder
#   npm run deploy -- release      sunucudaki kodla: npm ci → migrate → seed → pm2 reload → sağlık kontrolü
#   npm run deploy -- check        sunucuyu kontrol et (hiçbir şey değiştirmez)
#   npm run deploy -- logs         PM2 loglarını izle
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f deploy/deploy.env ]] || { echo "deploy/deploy.env yok: cp deploy/deploy.env.example deploy/deploy.env" >&2; exit 1; }
# shellcheck source=/dev/null
. deploy/deploy.env
: "${DEPLOY_HOST:?deploy/deploy.env içinde DEPLOY_HOST tanımlı değil}"
: "${DEPLOY_DIR:?deploy/deploy.env içinde DEPLOY_DIR tanımlı değil}"

CMD=${1:-all}
WITH_ENV=0
[[ ${2:-} == --env ]] && WITH_ENV=1

# Sunucuda nvm ile kurulmuş node/pm2 etkileşimsiz SSH'ta PATH'e girmez; önce yükle.
REMOTE_PRELUDE='set -euo pipefail; [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"; cd '"$DEPLOY_DIR"

remote() { ssh "$DEPLOY_HOST" "bash -c '$REMOTE_PRELUDE; $1'"; }

sync() {
  echo "▶ Kod gönderiliyor → $DEPLOY_HOST:$DEPLOY_DIR"
  ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR'"
  # --delete: sunucuda artık olmayan dosyaları siler. Hariç tutulanlara (.env, node_modules) DOKUNMAZ.
  rsync -az --delete \
    --exclude '.git/' --exclude 'node_modules/' --exclude '.husky/' --exclude 'coverage/' \
    --exclude 'test/' --exclude '.github/' --exclude '.env' --exclude '.env.*' \
    --exclude 'deploy/deploy.env' --exclude 'deploy/backup.env' --exclude 'logs/' \
    --exclude 'loadtest/users.json' --exclude 'openapi.json' --exclude '*.log' --exclude '.DS_Store' \
    ./ "$DEPLOY_HOST:$DEPLOY_DIR/"
  if ((WITH_ENV)); then
    [[ -f .env.production ]] || { echo ".env.production yok" >&2; exit 1; }
    echo "▶ .env.production → sunucuda .env (izin 600)"
    scp -q .env.production "$DEPLOY_HOST:$DEPLOY_DIR/.env"
    ssh "$DEPLOY_HOST" "chmod 600 '$DEPLOY_DIR/.env'"
  fi
}

release() {
  echo "▶ Yayına alınıyor"
  remote '
    [ -f .env ] || { echo "Sunucuda .env yok: npm run deploy -- sync --env" >&2; exit 1; }
    echo "  · bağımlılıklar"; npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
    echo "  · migration";     node scripts/migrate.js
    echo "  · seed";          node scripts/seed.js
    echo "  · pm2";           pm2 startOrReload ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null
    PORT=$(grep -E "^PORT=" .env | cut -d= -f2 | awk "{print \$1}")
    for i in $(seq 1 15); do
      if curl -fsS "http://127.0.0.1:${PORT:-3000}/health/ready" >/dev/null 2>&1; then
        echo "  ✔ /health/ready 200"; pm2 ls; exit 0
      fi
      sleep 1
    done
    echo "  ✖ /health/ready yanıt vermedi:" >&2
    curl -sS "http://127.0.0.1:${PORT:-3000}/health/ready" >&2 || true
    pm2 logs --nostream --lines 30 mochifast-api >&2
    exit 1
  '
}

case $CMD in
  all) sync; release ;;
  sync) sync ;;
  release) release ;;
  check) ssh "$DEPLOY_HOST" "bash -s" <deploy/check-server.sh ;;
  logs) remote 'pm2 logs mochifast-api mochifast-worker --lines 50' ;;
  *) echo "Bilinmeyen komut: $CMD (all | sync [--env] | release | check | logs)" >&2; exit 1 ;;
esac
