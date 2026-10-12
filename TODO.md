# TODO — senin doldurman / karar vermen gerekenler

Backend F0–F8 tamam; aşağıdakiler kod dışında kalan, anahtar, panel ayarı ya da karar gerektiren işler.
Sırası önemli olanlar üstte. Ayrıntılar `../fastingapp/docs/backend/` altında.

---

## 0. Önce (deploy'u engelleyenler)

- [ ] **Sunucudaki Nginx'i güncelle.** Canlı dosyada `client_max_body_size 2M` var: 2 MB üstü fotoğraf (avatar,
      öğün, analiz) API'ye ulaşmaz. `deploy/nginx/mochifast-api.conf`'taki iki `location` bloğunu (yükleme yolları
      11 MB, sohbet SSE `proxy_buffering off` + 120 sn) sunucudaki dosyaya ekle (certbot'un eklediği 443 bloğu dahil),
      sonra `nginx -t && systemctl reload nginx`.
- [ ] **Bunny private zone kur** (bkz. §2). Kurulmadan **üretim açılmaz**: sunucudaki `.env`'de
      `MEDIA_DRIVER=bunny` ve private zone ayarları zorunlu (kullanıcı fotoğrafları token'sız CDN'e yazılmasın diye
      bilinçli kilit).
- [ ] **Paylaşılan şifreleri değiştir:** DB şifresi ve Bunny storage şifresi sohbette açık yazıldı. Değiştirip
      yerel `.env`'e ve sunucudaki `.env`'e yeni değerleri koy.
- [ ] **Branch'i push'la / merge et:** `feat/backend-f0-f1` (F0–F10 commit'leri) henüz uzakta yok.
- [ ] **Sunucuda deploy:** `npm ci` → `npm run migrate` (0020'ye kadar) → `npm run seed` → `npm run stats:recompute`
      → PM2'de API **ve worker** yeniden başlat (yeni kuyruklar: `stats`, `media`, `ai`, `billing`, `notifications`, `account`; worker metrikleri `METRICS_WORKER_PORT`).
      `scripts/deploy.sh` migrate + seed + pm2'yi yapar; `stats:recompute`'u ilk seferde elle çalıştır.

- [ ] **Sunucuda Node ≥ 24.7** olmalı (yönetici şifreleri yerleşik `crypto.argon2` ile; `.nvmrc` 24 → `nvm install 24`).
- [ ] **İlk yönetici:** sunucuda `npm run admin:create -- <senin e-postan> owner` → çıkan geçici şifre + TOTP sırrını
      authenticator uygulamasına ekle, girişten sonra şifreyi değiştir (`POST /v1/admin/auth/password`). Kilitlenirsen
      `npm run admin:create -- <email> --reset`.

- [ ] **Dev ve prod aynı DB kullanıcısını/şifresini ve `MEDIA_PATH_SECRET`'ı paylaşıyor** (güvenlik denetimi): geliştirme
      bilgisayarı üretim hesabıyla internetten bağlanıyor demek. Lansmandan ÖNCE:
  - geliştirme için ayrı bir veritabanı + kullanıcı aç (cPanel), `.env`'yi ona çevir;
  - cPanel → Remote MySQL'de yalnızca VPS IP'si (ve gerekiyorsa senin IP'n — geliştirme DB'si için) kalsın;
  - üretim DB şifresini değiştir; üretimde **farklı** bir `MEDIA_PATH_SECRET` kullan (`openssl rand -hex 32`).
    ⚠️ Lansmandan SONRA `MEDIA_PATH_SECRET` değiştirilmez: medya yolları ondan türetilir, hesap silme eski dosyaları bulamaz.
- [ ] **Yönetim API'si üretimde kapalı** (`ADMIN_IP_ALLOWLIST` boş): ya IP'ni yaz ya da bilinçli olarak `ADMIN_ALLOW_ANY_IP=true`
      (şifre + TOTP + kilit yine zorunlu).
- [ ] **Yedekleme:** Bunny'de yeni storage zone (`mochifast-backups`, pull zone BAĞLAMA) → sunucuda `deploy/backup.env`
      (`deploy/backup.env.example`; `BACKUP_PASSPHRASE`'i parola yöneticisine de koy) → cron:
      `15 * * * * cd <DEPLOY_DIR> && scripts/backup-db.sh >> logs/backup.log 2>&1` → ilk tatbikat
      `scripts/restore-drill.sh mochifast_drill` ve sonucu `docs/runbooks.md` tablosuna yaz. Sunucuda `mysqldump`, `openssl`, `curl` olmalı.
- [ ] **İzleme:** Prometheus (ya da Grafana Cloud agent) → `127.0.0.1:9470` (API) ve `:9471` (worker), kurallar
      `deploy/monitoring/alerts.yml`; dışarıdan uptime (`/health/ready`); `SENTRY_DSN` + `SENTRY_TRACES_SAMPLE_RATE=0.05`.
- [ ] **Yük testi** staging'de (`loadtest/README.md`); k6: `brew install k6`.
- [ ] **Mağaza formları:** App Store gizlilik etiketi + Play Veri güvenliği → `../fastingapp/docs/backend/15-magaza-gizlilik.md`.

## 1. `.env` — boş alanlar (yerelde ve sunucudaki `.env`'de; değerleri sen gir)

Tek ortam dosyası `.env` (şablon `.env.example`). Sunucunun `.env`'i sunucuda tutulur; deploy göndermez.

| Anahtar                          | Nereden                                                                                                                                                                    | Boşken ne olur                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `BUNNY_PRIVATE_STORAGE_ZONE`     | Bunny → yeni storage zone (ör. `mochifast-private`, DE)                                                                                                                    | Geliştirmede `var/media`'ya yazar; üretim açılmaz                  |
| `BUNNY_PRIVATE_STORAGE_PASSWORD` | Private zone → FTP & API Access → Password                                                                                                                                 | 〃                                                                 |
| `BUNNY_PRIVATE_PULL_ZONE_HOST`   | Private zone'a bağlı **yeni** pull zone (ör. `mochifast-private.b-cdn.net`)                                                                                                | 〃                                                                 |
| `BUNNY_TOKEN_AUTH_KEY`           | **Private** pull zone → Security → Token Authentication → URL Token Authentication Key (şu an boş)                                                                         | 〃 (imzalı URL doğrulanamaz)                                       |
| `BUNNY_API_KEY`                  | Bunny → Account → API key (şu an boş)                                                                                                                                      | Avatar değişince / silmede CDN purge yapılmaz (dosya yine silinir) |
| `OPENAI_API_KEY`                 | platform.openai.com                                                                                                                                                        | Coach Mochi sohbeti ve fotoğraf analizi 503                        |
| `OPENAI_CHAT_MODEL`              | Kullanmak istediğin OpenAI sohbet modeli (varsayılan yok, bilinçli)                                                                                                        | Sohbet 503                                                         |
| `OPENAI_REASONING_EFFORT`        | Yalnızca reasoning model seçersen: `minimal\|low\|medium\|high`                                                                                                            | Gönderilmez (normal modelde boş kalsın)                            |
| `REVENUECAT_SECRET_API_KEY`      | RevenueCat → Project settings → API keys → **Secret** key (`sk_…`)                                                                                                         | Herkes ücretsiz; `/subscription/sync` 503                          |
| `REVENUECAT_WEBHOOK_AUTH`        | Uzun rastgele değer üret (`openssl rand -hex 32`), panelde webhook "Authorization header" alanına **aynısını** yaz (ör. `Bearer <değer>`; başlığın tamamı karşılaştırılır) | Webhook 503 (sync yine çalışır)                                    |
| `REVENUECAT_ALLOW_SANDBOX`       | TestFlight'ta premium verilsin mi? Üretimde boş = hayır                                                                                                                    | Üretimde sandbox satın alma premium vermez                         |
| `ADMIN_IP_ALLOWLIST`             | Panele girdiğin IP/VPN (ör. ofis IP'si)                                                                                                                                    | Yönetici API her IP'den erişilebilir (şifre + TOTP yine zorunlu)   |
| `CORS_ORIGINS`                   | Yönetim paneli adresi (ör. `https://admin.mochifast.app`)                                                                                                                  | Tarayıcıdaki panel API'ye istek atamaz                             |
| `SENTRY_DSN`                     | Sentry projesi (isteğe bağlı)                                                                                                                                              | Hata takibi kapalı                                                 |

## 2. Panel ayarları

### Bunny (private zone)

- [ ] Storage zone: `mochifast-private` (Falkenstein/DE + AB içi replikasyon).
- [ ] Pull zone: **Token Authentication AÇIK**, hotlink koruması, yalnızca GET; izin verilen uzantılar `webp` **ve `zip`** (veri dışa aktarma).
- [ ] (İsteğe bağlı) özel alan adı `media.mochifast.app` + TLS.
- [ ] Kurulumdan sonra staging'de kontrol: token'sız URL → 403, imzalı URL → 200 (bunu birlikte yapalım).

### Google Play Console

- [ ] **Veri güvenliği → Hesap silme URL'si:** `https://mochifast-api.fly-work.com/account/delete`
      (bilgi sayfası: uygulamadan silme adımları + destek e-postası). E-postayla gelen talebi panelden
      `POST /v1/admin/users/:id/deletion` ile işle.

### RevenueCat

- [ ] Proje + iOS/Android uygulamaları.
- [ ] Entitlement: `premium` (farklı isim verirsen `REVENUECAT_ENTITLEMENT`'i değiştir).
- [ ] Ürünler (öneri): `mochifast_premium_monthly`, `mochifast_premium_yearly` (deneme süreli) → offering `default`.
- [ ] **Paywall:** RevenueCat Paywalls ile tasarla (uygulama `purchases_ui_flutter` ile gösterir; sunucuda paywall yok).
- [ ] Webhook: `https://mochifast-api.fly-work.com/v1/webhooks/revenuecat` + Authorization header (`REVENUECAT_WEBHOOK_AUTH`).
- [ ] Sandbox satın alma testi: satın al → uygulama `POST /v1/subscription/sync` → `isPremium: true`.

### Firebase Cloud Messaging

- [x] Proje `mochifast-a3808`; `FIREBASE_PROJECT_ID` dolduruldu. `google-services.json` ve `GoogleService-Info.plist` uygulamaya kondu.
- [x] Google girişi: SHA'lar eklendi, Android dosyası yenilendi; iOS'a `CLIENT_ID` / `REVERSED_CLIENT_ID`, URL şeması ve `GIDClientID` eklendi.
      Release keystore ve Play App Signing SHA'ları da ekli olmalı (yayından önce kontrol).
- [x] 2 adımlı doğrulama açık. Android'de Apple girişi yok (karar).
- [x] Servis hesabı → `FCM_SERVICE_ACCOUNT_JSON` (`.env`, base64). FCM'e kimlik doğrulama denendi, çalışıyor.
      İndirilen JSON'u (`Downloads`) parola yöneticisine taşı ve sil; sızarsa Firebase → Service accounts'tan anahtarı iptal et.
- [ ] **APNs auth key (.p8) → Firebase:** Project settings → Cloud Messaging → Apple app configuration →
      APNs Authentication Key → **development ve production satırlarının ikisine de** aynı dosyayı Upload (Key ID `Y8B7RXY4QT`, Team ID `JK42R39DT5`). .p8'i repoya koyma,
      parola yöneticisinde sakla (Apple bir kez indirtiyor).
- [ ] Gerçek cihazla test: token kaydı → oruç başlat (kısa hedef) → hedefte push geliyor mu, sessiz saatte erteleniyor mu.

### `app_config` (DB'de; yönetim paneli F10'a kadar SQL ya da seed + `--overwrite-config`)

- [ ] `ai.pricing`: **OpenAI sohbet modelinin** fiyatını ekle (`{"<model>": {"inputPerMTok", "outputPerMTok", "cacheReadPerMTok", "cacheWritePerMTok"}}`).
      Yoksa sohbet maliyeti 0 görünür (bütçe sınırı yok; yalnızca raporlama/alarm).
- [ ] Canlı DB `app_config.ai.pricing`'e `gpt-4o` fiyatını ekle (seed yalnızca eksik anahtarı ekler, mevcut satırı güncellemez).
- [ ] `limits` — ücretsiz/premium günlük kotalar (sohbet 3/100, fotoğraf 2/30): karar #7.
- [ ] `legal.termsUrl` / `legal.privacyUrl` — şu an `null`; kullanım şartları ve gizlilik metni URL'leri.

## 3. Gerçek modelle doğrulama (anahtarlar gelince birlikte)

- [ ] **Fotoğraf analizi eval'i:** kalorisi bilinen ~100 öğün + 20 yemek dışı fotoğraf → `eval/meals/` +
      `manifest.json` (biçim: `scripts/eval-meal-analysis.js` başı). Önce `npm run eval:meals -- --dir eval/meals --limit 10`.
      Hedef: kcal MAPE ≤ %25, `isFood` ≥ %98, p95 < 12 sn. `eval/` git'e girmez.
- [ ] **Sohbet red-team:** `npm run redteam:chat` → `redteam/results/*.md`'deki 14 vakayı elle işaretle
      (enjeksiyon, yeme bozukluğu, 18 yaş altı, ilaç dozu, 72 sa oruç, acil belirti, hamilelik, kapsam dışı).
- [ ] **Performans:** API (VPS) ile MariaDB (cPanel) arası gecikme? Geliştirmede her sorgu ~52 ms; yazmalar ~1 sn,
      `/user/summary` ~0,8 sn. Aynı makine/veri merkezinde değilse F3 kabul kriteri (summary p95 < 120 ms) tutmaz.

## 4. Çeviri ve içerik gözden geçirme

- [ ] Benim yazdığım metinler (anadil kontrolü iyi olur):
  - açlık check-in güvenlik önerisi `safety_end_fast` (7 dil) — `scripts/extract-translations.js`
  - sohbet ret mesajı (7 dil) — `src/modules/chat/chat.service.js` `REFUSAL_TEXT`
  - **Günün ipuçları** (10 × 7 dil) — `seeds/catalog_labels.json` → `daily_tip`
  - **20 bildirim şablonu × 7 dil** — `seeds/notifications.json` (çoğu yeni; ton ve uzunluk push için kısa olmalı)
  - 3 challenge'ın metinleri (`week_fasts_3`, `water_week_5`, `hunger_aware_5`) — `seeds/gamification.json`
- [ ] Uygulama çevirileri: İspanyolca/Fransızca çevrilmemiş metinler (ayrı görev açılmıştı); İngilizce
      `home.challenge_title` "challange" yazım hatası (seed'de düzelttim, uygulamada duruyor).
- [ ] Persona/prompt metinleri: `prompts/coach_mochi.v1.md`, `prompts/meal_analysis.v1.md` (değişirse sürüm artır).

## 5. Uygulama (Flutter) tarafı — backend hazır, bağlanmayı bekliyor

- [ ] Firebase (Apple/Google girişi) → `POST /v1/auth/register`; misafir → hesap yükseltme.
- [ ] Ana sayfa `GET /v1/user/summary`; oruç akışı `/v1/fasts/*`; hafta şeridi `/v1/fasts/week`.
- [ ] Takipçi ekranları (su, kilo grafiği, adım, uyku, öğün, beslenme, açlık) mock'lardan API'ye.
- [ ] Medya: avatar `PUT /v1/user/me/avatar`; öğün fotoğrafı; görsel cache anahtarı `${id}_${variant}`; 403'te URL yenile.
- [ ] AI: **`aiProcessing` rızası** onboarding'de toplanmıyor → ilk AI kullanımından önce sor (`POST /v1/user/consents`), yoksa 403.
      Fotoğraf analizi: gönder → `pollAfterMs` ile yokla → düzenle → `POST /v1/meals {analysisId}`.
- [ ] Sohbet: SSE istemcisi (`message.created` / `delta` / `message.completed` / `error`), `safety: "urgent"` kartı, kota (429) → paywall.
- [ ] Mochi World `GET /v1/world` (seviyeyi sunucudan al); challenge kartı `featured` + `join`.
- [ ] RevenueCat: `Purchases.logIn(userId)` (bizim UUID), paywall `purchases_ui_flutter`, satın alma/geri yükleme sonrası
      `POST /v1/subscription/sync`; 402 / 429 (`upgradeAvailable`) → paywall; profildeki sabit `isPremium: true`'yu kaldır.
- [ ] Bildirimler: FCM izni (onboarding'de ya da ilk oruçta) → `PUT /v1/devices/current {pushToken, pushEnabled}`;
      `onTokenRefresh`'te tekrar gönder. Android'de `quiet` kanalı (düşük önem) oluştur — sessiz saat push'ları oraya gider.
- [ ] Inbox ekranı `GET /v1/notifications` + rozet `unread-count`; okundu / tümü okundu / kaydırarak sil.
      Push verisindeki `deepLink` ile yönlendirme (`notificationId` gelirse okundu işaretle).
- [x] **Hesabı sil** Profili Düzenle ekranının en altında: onay → Apple ile girildiyse token iptali → `DELETE /v1/user/me` → çıkış;
      abonelik varsa uyarı. Girişte `409 ACCOUNT_PENDING_DELETION` → geri alma sorusu → `restoreAccount: true`.
      (Kod yazıldı, cihazda denenmedi.)
- [ ] Verilerimi indir: uygulamada **bilinçli olarak yok** (karar). Backend ucu hazır (`POST /v1/user/me/export`); KVKK/GDPR
      erişim talebi gelirse destekten tetiklenebilir ya da ekran sonradan eklenir.
- [ ] Yeniden onay: `GET /v1/user/me` → `requiredConsents` boş değilse şartlar/gizlilik ekranı → `POST /v1/user/consents`.
      Ayarlarda rıza anahtarları (sağlık verisi, AI, pazarlama); sağlık geri çekilince kayıt ekranları 403 gösterir.
- [ ] Bildirim ayarları ekranı: kategoriler (`fasting`, `streak`, `weight`, `water`, `challenges`, **`world`**), sessiz saatler,
      su hatırlatma aralığı → `PATCH /v1/user/settings`. Uygulamadaki yerel oruç bildirimlerini kaldır (çift bildirim olur).

## 6. Bilinçli ertelenenler / açık kararlar

- [ ] `/user/summary` cache'i: bildirimler domain servislerinden doğrudan planlandı, ayrı olay altyapısı gerekmedi; cache ihtiyaç olursa.
- [ ] İnaktif **kayıtlı** hesap saklama (24 ay + uyarı + 30 gün): e-posta kanalı olmadığı için yapılmadı.
- [ ] **Yönetim paneli arayüzü** ayrı proje (React/Refine vb.): API hazır (`/v1/admin/*`, 04 §19). İçerik bölüm
      dokümanı biçiminde düzenlenir; panelden kaydedilen bölümü `npm run seed` artık ezmez (seed dosyasındaki değişiklik o
      bölüme yansımaz → panelden yapılmalı ya da sürüm geri alınmalı).
- [ ] Ürün analitiği (PostHog/Amplitude) yapılmadı; raporlar şimdilik DB'den (`/v1/admin/reports/overview`).
- [ ] Widget yenilemesi için sessiz push (F9 opsiyonel) yapılmadı. `subscription_expiring`, dışa aktarma ve hesap silme
      bildirimlerinin tetikleyicileri F10'da.
- [ ] Challenge katılımcı avatarları: "challenge'larda görün" izin ayarı yok → liste boş, istemci maskot gösteriyor. İstersen ekleriz.
- [ ] Fast Forecast v0 ve günlük ipucu (F7 opsiyonel) yapılmadı.
- [ ] Saat dilimi değişimi / yaz saati (DST) test senaryoları → F11.
- [ ] Gece doğrulaması (`dailyRollup`) sabit 03:30 UTC değil, worker açılışından itibaren 24 saatte bir.
- [ ] Kararlarımı onayla ya da değiştir: onboarding kilosu XP vermiyor; yeme bozukluğu bayrağında elle girilen kalori
      hedefi de gizleniyor; "seri günü" challenge metriği basitleştirilmiş (şu an katalogda yok).
- [ ] Açık kararlar listesi: `../fastingapp/docs/backend/14-acik-kararlar.md`.
