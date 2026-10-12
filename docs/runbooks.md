# Runbook'lar

Alarm kuralları: `deploy/monitoring/alerts.yml`. Sunucu: PM2 (`mochifast-api`, `mochifast-worker`),
Nginx önde, ayrıntı `docs/deploy.md`. Komutların çoğu sunucuda uygulama klasöründe çalışır.

İlk 5 dakika her olayda aynıdır:

```bash
npm run deploy -- check          # bilgisayardan: sunucu, süreçler, sağlık
pm2 ls && pm2 logs --lines 200   # sunucuda
curl -s localhost:3070/health/ready
```

---

## API yanıt vermiyor

1. `pm2 ls`: `mochifast-api` `errored` / sürekli yeniden başlıyorsa `pm2 logs mochifast-api --err --lines 200`.
2. `/health/ready` 503 ve `db` hatası → DB'ye erişim (cPanel Remote MySQL'de sunucu IP'si izinli mi, şifre değişti mi).
3. Bellek: `max_memory_restart: 512M` döngüsü → son deploy'u geri al (aşağıda), sızıntıyı staging'de ara.
4. Yapılandırma hatası (yeni `.env` anahtarı eksik) açılışta loglanır ve süreç çıkar → sunucudaki `.env`'i düzelt, `npm run deploy -- release`.

## 5xx artışı

1. Sentry'de en sık hata ve başladığı sürüm. Son deploy ile çakışıyorsa **önce geri al**, sonra incele.
2. Tek uca özgüyse (`route` etiketi) ilgili dış servis: AI (`UNAVAILABLE reason=ai_*`), RevenueCat (`billing_upstream`), Bunny (`storage`). Bu hatalar 503 döner; devre kesici (`infra/breaker.js`) kendiliğinden toparlar.
3. DB kaynaklıysa (kilit, `ER_LOCK_WAIT_TIMEOUT`): uzun süren sorgu `SHOW FULL PROCESSLIST`.

## Yavaşlama

1. `db_pool_connections{state="queued"}` artıyorsa havuz doymuş: yavaş sorgu logu (`DB_SLOW_QUERY_MS`) → `EXPLAIN`.
2. Cache isabeti düştüyse (`cache_requests_total`), son deploy'da cache anahtarı değişmiş olabilir; ya da katalog sürümü sürekli artıyor (`catalog.version`, panel kayıtları).
3. VPS ↔ cPanel DB gecikmesi: `SELECT 1` süresi. Kalıcıysa DB'yi API ile aynı ağa taşı (07 §9).

## Worker durdu

Etkisi: bildirim, hesap silme, fotoğraf analizi, istatistik, abonelik senkronu durur (API çalışır).

1. `pm2 restart mochifast-worker`; `pm2 logs mochifast-worker`.
2. Açılışta `zamanlamalar eşitlenemedi` → DB/migration. `npm run migrate:status`.
3. Toparlanınca birikim kendiliğinden erir; `jobs_oldest_pending_seconds` düşmeli.

## Kuyruk birikiyor

1. Hangi kuyruk: `jobs_oldest_pending_seconds`, ayrıntı:
   ```sql
   SELECT queue, name, status, COUNT(*), MIN(run_at) FROM jobs
    WHERE status IN ('pending','running','failed') GROUP BY queue, name, status;
   SELECT id, name, attempts, last_error FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 20;
   ```
2. Tek iş türü sürekli hata veriyorsa (`jobs_runs_total{outcome="failed"}`) `last_error`'a bak; dış servis kesintisinde iş geri çekilerek (backoff) tekrar dener.
3. Kalıcı başarısız işi tekrar çalıştırma: düzeltmeden sonra `UPDATE jobs SET status='pending', attempts=0, run_at=NOW(3) WHERE id = …`.
4. Zamanlanmış hesap silme `failed` olduysa: `SELECT * FROM account_deletion_requests WHERE status='failed'` → sebebi gider → `UPDATE … SET status='scheduled'` (sonraki saatlik süpürmede çalışır).

## Push gitmiyor

1. `push_deliveries_last_hour`: `failed` çoksa `push_deliveries.error_code`:
   - `app/invalid-credential` → `FCM_SERVICE_ACCOUNT_JSON` (anahtar iptal edilmiş/yanlış).
   - `messaging/third-party-auth-error` → APNs anahtarı (Firebase → Cloud Messaging → APNs Authentication Key).
2. `notifications_overdue` artıyorsa dağıtıcı takılmış → worker (yukarıda).
3. Gönderilmeyen ama gönderilmesi gereken: `scheduled_notifications.last_error` (sessiz saat, sınır, kategori kapalı normaldir).

## AI maliyet patlaması

Global AI bütçe sınırı yoktur (kullanıcı kararı 2026-10-12); maliyet yalnızca `ai_usage_daily`'de izlenir.

1. Kim: `SELECT user_id, feature, SUM(requests), SUM(cost_micro_usd)/1e6 FROM ai_usage_daily WHERE usage_date = UTC_DATE() GROUP BY user_id, feature ORDER BY 4 DESC LIMIT 20;`
2. Tek kullanıcı kötüye kullanıyorsa: panelden oturumlarını kapat (`POST /v1/admin/users/:id/sessions/revoke`); gerekirse `users.status = 'banned'`.
3. Genel artışta kotaları düşür: `PUT /v1/admin/config/limits` (`freeChatDaily`, `premiumChatDaily`…) ya da AI'yı geçici kapat: `PUT /v1/admin/config/features` (`chat: false`, `photoAnalysis: false`).
4. Sağlayıcı panelinden (OpenAI) aylık harcama limiti zaten tanımlı olmalı.

## Kötü deploy geri alma

Kod: bilgisayarda son sağlam commit'e dön ve yeniden gönder.

```bash
git log --oneline -10
git checkout <sağlam-commit> && npm run deploy && git checkout -
```

Migration'lar **yalnızca ileri** yönlüdür: geri alınan kod yeni tabloları/kolonları kullanmaz, kalmaları zararsızdır (kolon silen/yeniden adlandıran migration yazılmaz; önce kod, sonra ayrı bir deploy'da şema temizliği).

## DB migration geri dönüşü

- Migration başarısız olduysa transaction'sız DDL yarım kalmış olabilir: `npm run migrate:status`, hatalı migration'ın yaptığı kısmı elle geri al, düzelt, yeniden çalıştır.
- Uygulanmış bir migration'ın etkisini geri almak gerekiyorsa **yeni** migration yazılır (`npm run migrate:new`); uygulanmış dosya düzenlenmez (checksum).
- Veri kaybı olduysa: yedekten geri yükleme (aşağıda).

## Yedekten geri yükleme (felaket)

RPO: saatlik yedek → ≤ 1 sa veri kaybı (cPanel MariaDB'de PITR yok). RTO hedefi < 2 sa.

1. API ve worker'ı durdur: `pm2 stop all` (yazmalar dursun).
2. Yeni (boş) bir veritabanına geri yükle ve doğrula:
   `scripts/restore-drill.sh mochifast_restore` — **dikkat:** betik maskeleme yapar; gerçek geri yükleme için maskeleme bloğunu atlayarak manuel yükle:
   ```bash
   curl -H "AccessKey: …" https://storage.bunnycdn.com/<zone>/db/… -o dump.enc
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE < dump.enc | gunzip | mysql <yeni_db>
   ```
3. `.env`'de `DB_NAME`'i yeni veritabanına çevir, `npm run migrate:status`, `pm2 start all`.
4. Yedek ile kesinti arasındaki RevenueCat abonelikleri webhook/senkronla kendiliğinden toparlanır; kullanıcı verisi (oruç, kilo) kaybolan aralık için kullanıcılara bilgi verilir.

## Geri yükleme tatbikatı (üç ayda bir)

`scripts/restore-drill.sh mochifast_drill_YYYYMMDD` → çıktıdaki süreleri buraya yaz, tatbikat DB'sini sil.

| Tarih | Yedek | Boyut | Yükleme | Toplam | Not |
| ----- | ----- | ----- | ------- | ------ | --- |
|       |       |       |         |        |     |

## Anahtar rotasyonu

| Anahtar                                          | Nasıl                                                                                                                                                                                                                                             | Kesinti                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| JWT (`JWT_PRIVATE_JWK`)                          | `npm run keys:jwt` → yeni özel anahtar `JWT_PRIVATE_JWK`, açık anahtarı `JWT_PUBLIC_JWKS`'e **ekle** (eskisi kalır) → deploy → 15 dk sonra (access ömrü) eski açık anahtarı listeden çıkar → deploy                                               | Yok                               |
| Alan şifreleme (`FIELD_ENCRYPTION_KEYS_JSON`)    | `npm run keys:field` → yeni kid'i JSON'a **ekle**, `FIELD_ENCRYPTION_ACTIVE_KID` yeni kid → deploy. Eski kayıtlar eski kid'le çözülmeye devam eder; eski anahtar **asla silinmez** (sızıntıda: yeni kid + eski verileri yeniden şifreleyen betik) | Yok                               |
| Bunny (storage şifresi, token auth key, API key) | Panelde yenile → sunucudaki `.env` → `npm run deploy -- release`. Token key değişince eski imzalı URL'ler 403 olur; istemci yeniler                                                                                                               | İmzalı URL'ler ≤ 1 sa             |
| OpenAI                                           | Konsolda yeni anahtar → sunucudaki `.env` → `npm run deploy -- release` → eskisini iptal et                                                                                                                                                       | Yok                               |
| RevenueCat secret / webhook auth                 | Panelde yenile; webhook Authorization değerini panel ve `.env`'de birlikte değiştir                                                                                                                                                               | Webhook birkaç dk (senkron sürer) |
| FCM servis hesabı                                | Firebase → Service accounts → yeni anahtar → `FCM_SERVICE_ACCOUNT_JSON` (base64) → deploy → eskisini sil                                                                                                                                          | Yok                               |
| Yönetici şifresi/TOTP                            | `npm run admin:create -- <email> --reset` ya da owner panelden                                                                                                                                                                                    | Yok                               |
| Yedek parolası                                   | Yeni parolayla yedek almaya başla; eski yedeklerin parolasını 30 gün (saklama) tut                                                                                                                                                                | Yok                               |

## Olay müdahalesi (güvenlik / veri sızıntısı)

1. **Durdur:** sızan anahtarı hemen döndür (yukarıdaki tablo); şüpheli yönetici hesabını pasifleştir (`PATCH /v1/admin/admins/:id {isActive:false}`); gerekirse tüm kullanıcı oturumlarını iptal et (`UPDATE sessions SET revoked_at = NOW(3), revoke_reason = 'admin' WHERE revoked_at IS NULL`).
2. **Kanıt:** `audit_logs` (yönetici işlemleri, girişler), Nginx erişim logları, Sentry; dokunmadan kopyala.
3. **Kapsam:** hangi veriler, kaç kullanıcı, hangi aralık.
4. **Bildirim:** KVKK: Kurul'a **72 saat** içinde; etkilenen kişilere makul sürede. GDPR (AB kullanıcıları) aynı süre.
5. **Kök neden ve düzeltme**, sonra kısa bir olay sonrası notu (bu dosyanın altına).
