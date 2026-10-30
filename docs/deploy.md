# Yayına alma (VPS · Nginx · PM2)

Sunucu düzeni: Nginx önde (TLS, certbot), uygulama `127.0.0.1:3066` portunda PM2 ile çalışır, MySQL aynı sunucudadır.
Redis ya da Docker **gerekmez**.

| Ne             | Değer                                                                        |
| -------------- | ---------------------------------------------------------------------------- |
| Alan adı       | `mochifast.fly-work.com`                                                     |
| Uygulama portu | `3066` (yalnızca 127.0.0.1)                                                  |
| Metrik portu   | `9470` (yalnızca 127.0.0.1)                                                  |
| PM2 süreçleri  | `mochifast-api`, `mochifast-worker`                                          |
| Sunucu klasörü | `deploy/deploy.env` → `DEPLOY_DIR` (varsayılan `/var/www/mochifast-backend`) |

Alan adı ya da port değişirse üç yeri birlikte güncelle: sunucudaki `.env` (`PORT`, `PUBLIC_BASE_URL`), `deploy/nginx/mochifast-api.conf` (`server_name`, `upstream`).

## İlk kurulum (bir kez)

### 1. DNS

`mochifast.fly-work.com` için sunucu IP'sine giden bir **A kaydı** ekle.

### 2. Bilgisayarında deploy ayarı

```bash
cp deploy/deploy.env.example deploy/deploy.env
```

`DEPLOY_HOST=root@SUNUCU_IP` satırını kendi değerinle doldur. `ssh root@SUNUCU_IP` şifre sormadan girebiliyor olmalı (SSH anahtarı).

### 3. Sunucuyu kontrol et (hiçbir şey değiştirmez)

```bash
npm run deploy -- check
```

Bakılacaklar:

- **node v24+** olmalı. Eskiyse sunucuda: `nvm install 24`. Diğer uygulamalar eski Node'da kalacaksa `ecosystem.config.cjs` içindeki iki uygulamaya `interpreter: '/root/.nvm/versions/node/v24.x.x/bin/node'` ekle.
- **mysql:** MySQL 8.0+ ya da MariaDB 10.6+ olmalı. Kuyruk `SKIP LOCKED` kullanıyor.
- **rsync** olmalı. Yoksa: `apt install rsync` / `dnf install rsync`.
- **3066** ve **9470** portları boş olmalı.

### 4. Kodu gönder, sunucuda `.env`'i oluştur, yayına al

```bash
npm run deploy -- sync      # yalnızca kod (sunucudaki .env'e dokunmaz)
```

Sunucuda `.env`'i `.env.example`'dan oluştur ve üretim değerlerini gir (`NODE_ENV=production`, `PORT`,
`PUBLIC_BASE_URL`, `MEDIA_DRIVER=bunny`, `TRUST_PROXY`, anahtarlar…). Deploy bu dosyayı göndermez, silmez, ezmez:

```bash
ssh root@SUNUCU_IP
cd /var/www/mochifast-backend && cp .env.example .env && chmod 600 .env && nano .env
```

Sonra bilgisayarından:

```bash
npm run deploy -- release   # npm ci → migrate → pm2 → /health/ready kontrolü
```

`release` sonunda `✔ /health/ready 200` ve PM2 listesini görmelisin.

### 5. Nginx + SSL (sunucuda)

```bash
cd /var/www/mochifast-backend
cp deploy/nginx/mochifast-api.conf /etc/nginx/conf.d/mochifast.fly-work.com.conf
nginx -t && systemctl reload nginx
certbot --nginx -d mochifast.fly-work.com -m info@fly-work.com --agree-tos --no-eff-email
```

Kontrol (bilgisayarından):

```bash
curl https://mochifast.fly-work.com/health/ready
```

### 6. PM2 kalıcılığı ve log döndürme (sunucuda; daha önce yaptıysan atla)

```bash
pm2 startup            # yazdığı komutu çalıştır (sunucu yeniden başlayınca PM2 açılsın)
pm2 save
pm2 install pm2-logrotate
```

## Her deploy

```bash
npm run deploy
```

Sırasıyla şunları yapar: kodu gönderir (`.env` ve `node_modules` korunur), `npm ci --omit=dev` çalıştırır, migration'ları uygular, `pm2 startOrReload` ile süreçleri yeniler ve `/health/ready` 200 dönene kadar bekler. Migration hata verirse süreçler **yeniden başlatılmaz**, çalışan sürüm hizmet vermeye devam eder.

API tek process çalıştığı için yeniden başlarken 1–2 sn kesinti olur. Nginx bu sırada 502 döner; uygulama istemcisi tekrar dener.

## `.env` değiştirmek

Sunucudaki `.env`'i sunucuda düzenle (`nano /var/www/mochifast-backend/.env`), sonra:

```bash
npm run deploy -- release
```

## Sorun giderme

```bash
npm run deploy -- logs                                   # canlı PM2 logları
ssh root@SUNUCU_IP 'pm2 ls'
curl -s http://127.0.0.1:3066/health/ready               # sunucuda: hangi kontrol düşük?
```

Kuyruğun durumu (sunucuda `mysql` ile):

```sql
SELECT queue, status, COUNT(*) FROM jobs GROUP BY queue, status;
SELECT id, name, attempts, last_error FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 20;
-- Başarısız bir işi yeniden denemek için:
UPDATE jobs SET status = 'pending', attempts = 0, run_at = NOW(3), finished_at = NULL WHERE id = 123;
```

Biten işler 7 gün, başarısız işler 30 gün sonra otomatik silinir (`system-jobs-cleanup`, saatlik).
