#!/usr/bin/env bash
# Sunucunun MochiFast için hazır olup olmadığını gösterir. HİÇBİR ŞEYİ DEĞİŞTİRMEZ.
# Yerelden: npm run deploy -- check
# Sunucuda: bash deploy/check-server.sh
APP_PORT=${APP_PORT:-3070}
METRICS_PORT=${METRICS_PORT:-9470}

[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

row() { printf '  %-14s %s\n' "$1" "$2"; }
ver() { command -v "$1" >/dev/null 2>&1 && "$@" 2>/dev/null | head -1 || echo "YOK"; }

echo "Sunucu: $(hostname)  ·  kullanıcı: $(whoami)"
row "İşletim sist." "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
row "Bellek" "$(free -h 2>/dev/null | awk '/Mem:/ {print $2 " toplam, " $7 " boş"}')"
row "Disk (/)" "$(df -h / | awk 'NR==2 {print $4 " boş"}')"
row "node" "$(ver node --version)  (gereken: v24+)"
row "npm" "$(ver npm --version)"
row "pm2" "$(ver pm2 --version)"
row "rsync" "$(command -v rsync >/dev/null && echo var || echo YOK)"
row "nginx" "$(ver nginx -v 2>&1)"
row "certbot" "$(ver certbot --version)"
row "mysql" "$(ver mysql --version)"
echo
echo "Kullanılacak portlar (boş olmalı):"
for p in "$APP_PORT" "$METRICS_PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    row "$p" "DOLU  ← $(ss -ltnp 2>/dev/null | grep -E "[:.]$p " | grep -oE 'users:\(\("[^"]+' | cut -d'"' -f2 | head -1)"
  else
    row "$p" "boş"
  fi
done
echo
echo "PM2 süreçleri:"
command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { for (const p of JSON.parse(s)) console.log(`  ${p.name.padEnd(28)} ${p.pm2_env.status}`); }
    catch { console.log("  (okunamadı)"); }
  });' || echo "  pm2 yok"
