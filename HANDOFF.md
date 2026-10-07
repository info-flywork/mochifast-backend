# HANDOFF — MochiFast (devam edecek geliştirici / yapay zekâ için)

Son güncelleme: 2026-10-07. Bu dosya, işi yarıda devralan birinin bağlamı hızla kurması için yazıldı.
Ayrıntılı tasarım: `../fastingapp/docs/backend/*.md` (Türkçe). Kullanıcının yapacakları: `TODO.md`.
Operasyon: `docs/runbooks.md`, `docs/deploy.md`.

## 1. Proje

| Repo    | Yol                                         | Ne                                                                                                               |
| ------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Backend | `/Users/flywork/Projects/mochifast-backend` | Node.js (≥ 24.7), Fastify 5, **düz JavaScript (ESM), TypeScript YOK**, mysql2 (cPanel MariaDB), Docker/Redis YOK |
| Mobil   | `/Users/flywork/Projects/fastingapp`        | Flutter (BLoC, go_router, get_it, dio, easy_localization). Dokümanlar `docs/backend/`                            |

Kullanıcı Türkçe konuşur, samimi dil ("kanka") kullanır. Cevaplar Türkçe.

## 2. Kurallar (ihlal etme)

- **Flutter reposuna (`fastingapp`) commit ATMA.** Değişiklikler çalışma ağacında kalır; kullanıcı kendisi commit eder.
- Backend'de commit: conventional + **küçük harfli konu** (commitlint), ör. `feat(fasting): …`. Sonuna:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Pre-commit hook eslint + prettier çalıştırır.
- **Asla commit etme / içeriğini yazdırma:** `.env`, `.env.production`, `deploy/deploy.env`, `deploy/backup.env`, `loadtest/users.json`.
- `.env` dosyalarına yeni anahtar eklerken yalnızca **eksik** anahtarı ekle, değerleri ekrana basma.
- Admin API üretimde **kapalı kalacak** (kullanıcı kararı). Firebase **Web app istenmiyor** (kullanıcı kararı).
- DB şifresi/`MEDIA_PATH_SECRET` ayrımını kullanıcı üretimde kendisi yapacak; dokunma.
- Uygulanmış migration dosyasını düzenleme; yeni migration ekle (`npm run migrate:new`). Uzak DB'ye `npm run migrate` ile uygula (`.env` uzak cPanel DB'yi gösterir).

## 3. Çalıştırma

```bash
# Backend (iki süreç)
cd /Users/flywork/Projects/mochifast-backend
npm run dev            # API → http://localhost:3000 (değişince yeniden başlar)
npm run worker:dev     # kuyruk + zamanlayıcı
npm test               # vitest; MySQL testleri .env'deki TEST_MYSQL_URL ile (yerel MySQL)
npm run lint && npx prettier --check .

# Flutter (iOS simülatör, yerel backend'e bağlı)
xcrun simctl boot 5D8D6F5E-ED9F-42EE-BE7C-A65E532BCB44   # iPhone 17 Pro; gerekirse
cd /Users/flywork/Projects/fastingapp
LANG=en_US.UTF-8 flutter run -d 5D8D6F5E-ED9F-42EE-BE7C-A65E532BCB44 --dart-define-from-file=dart_defines/local.json
```

Tuzaklar:

- `pod install` Türkçe locale'de çöker → komutları `LANG=en_US.UTF-8` ile çalıştır.
- **`dart format lib` ÇALIŞTIRMA** (ilgisiz onlarca dosyayı yeniden biçimler); yalnızca değiştirdiğin dosyaları biçimle.
- `build_runner --build-filter` diğer `.g.dart` dosyalarını siler; tek model değişince `.g.dart`'ı elle güncelle.
- `npm audit fix --omit=dev` devDependencies'i `node_modules`'tan siler → ardından `npm ci`.
- `flutter analyze` çıktısındaki `hunger_history_log_view`, `mochi_world_view`, `steps_view` uyarıları eskiden beri var.

## 4. Durum

Yol haritası: `../fastingapp/docs/backend/12-yol-haritasi.md`. Backend F0–F10 tamam, F11 1. hafta tamam.
Son backend commit'leri: `0b50836` (misafir sırrı), `3b20902` (kullanılmayan şablon), `9ec59e5` (günün ipucu),
`bf58398` (refresh aile limiti), `d99a0df` (Fast Forecast), `a14d31a` (bu dosya), `4d03412` (eski önek'siz yollar silindi),
`df0d871` (F11 sertleştirme), `0ad5487`, `77748b7` (F10), `d85c836`, `3d1e84c` (F9).
Testler: 43 dosya / 388 test geçiyor. Uzak DB migration'ları 0021'e kadar uygulandı; seed güncel.

Modüller (`src/modules`): auth, user, account (silme/dışa aktarma/saklama), admin, devices, catalog, plans, fasting,
stats, trackers (kilo/su/adım/uyku), meals, hunger, ai (fotoğraf analizi, Claude), chat (OpenAI, SSE), gamification
(Mochi World, challenge), billing (RevenueCat), notifications (FCM + inbox), media (Bunny), app (config).
İşler: `src/jobs/*.jobs.js`, zamanlama `src/schedules.js`, worker `src/worker.js`.

## 5. Backend'de kalanlar (öncelik sırasıyla)

1–5 tamamlandı (2026-10-07). Kalan backend işi yalnızca opsiyonel/bağımlı maddeler (6, 7).

Durumu güncelle: bitirince `[x]` yap.

1. [x] **Fast Forecast v0** `GET /v1/fasts/forecast` — uygulamadaki `fasting_fast_forecast_card` (doküman 13 §4: "%87, 14:00…").
       Son 14 günün oruçlarından: bugün hedefi tutturma olasılığı (tamamlama oranı + bugüne kadarki seri), tahmini bitiş
       saati (aktif oruç varsa `startedAt + target`, yoksa plan yeme penceresi sonu), "en zor saat" (geçmiş zorlanma
       olaylarının (`struggle_events`) en sık saati). Veri azsa `{available:false}` → istemci kartı gizler. Testleri ekle.
2. [x] **Günlük ipucu** `GET /v1/fasts/daily-tip` — `fasting_mochi_plan_card`. AI kullanma; katalogdaki
       (`content.items` / insights) ipuçlarından gün + kullanıcıya göre deterministik seçim, dile göre. Cache'le.
3. [x] **Refresh için aile başına limit** (06 §7: 30/saat) — `src/modules/auth/auth.service.js` `refresh()`; `createWindowLimiter` ile `familyId` anahtarı.
4. [x] **Sunucu tarafı misafir sırrı** (güvenlik denetimi bulgu 7): misafir oluşturulurken rastgele sır üret, hash'ini
       `auth_identities`'te sakla, yanıtla bir kez dön; sonraki `/auth/guest` girişlerinde iste (istemci güncellemesiyle
       birlikte; geçiş için sırsız eski misafirlere izin ver). İstemci: `DeviceManager` yanında Keychain'de sakla.
5. [x] `account_deletion_scheduled` bildirim şablonu kullanılmıyor (silme talebinde push token'lar silindiği için
       gönderilemez). Ya şablonu kaldır ya da talepten önce anlık push gönder.
6. [ ] (Opsiyonel) widget yenilemesi için sessiz push (F9), ürün analitiği (PostHog/Amplitude, rıza kontrollü).
7. [ ] (E-posta kanalı gelince) 24 ay inaktif kayıtlı hesap uyarısı + silme (06 §8.4).

F11'in kalan kısmı (pentest, prod kurulumu, Prometheus, yedek cron, yük testi çalıştırma, lansman) **kullanıcıyla
birlikte** yapılır; liste `TODO.md` en üstte.

## 6. Flutter entegrasyonu (uygulama tarafı)

Plan: `../fastingapp/docs/backend/13-flutter-entegrasyonu.md` (§4'te ekran ekran sabit veri → API tablosu).

Yapıldı (commit edilmedi, `fastingapp` çalışma ağacında):

- Firebase (Apple/Google) giriş: `lib/domain/auth/social_auth_service.dart`, `auth_repository.dart`, `welcome_bloc.dart`; `409 ACCOUNT_PENDING_DELETION` → geri alma diyaloğu.
- Ağ: `lib/core/network/` — `ContextInterceptor` (X-Timezone, X-App-Version, X-Platform, X-Install-Id, Idempotency-Key), uygulama diline göre `Accept-Language`, tek uçuşlu token yenileme (`expired_token_interceptor.dart`), `NetworkException.code/details`.
- Oturum: `AuthBloc` açılışta önbellekten; `AuthSessionEnded`; çıkış `POST /auth/logout`; router'da yalnızca giriş/onboarding rotaları herkese açık; splash onboarding'i bitmişse home'a.
- Onboarding: `lib/domain/onboarding/` (`OnboardingDraft` + `OnboardingRepository`); "Başla"da misafir oturumu, her adım taslağa yazar, BuildingPlan'da `POST /v1/user/onboarding`, WeightProjection sunucu projeksiyonuyla; GoodCompany sahte oturum kaldırıldı.
- Misafir sırrı: `DeviceManager` Keychain'de saklar; `AuthRepository.loginAsGuest` gönderir, `guest_secret_invalid`'de kurulum kimliğini sıfırlayıp yeni misafir açar.
- Oruç ekranı Forecast kartı → `GET /v1/fasts/forecast` (`lib/domain/fasting/forecast_repository.dart`); güven %, en zor saat, risk aralığı, oruç süresi gerçek; veri yoksa kart gizli. Grafik eğrisi hâlâ örnek. Günün ipucu (`/v1/fasts/daily-tip`) için uygun kart yok (Mochi plan kartı plan yayı; ipucu metni eklenecekse orası).
- Bildirim kutusu (Profil → Bildirimler) → `GET /v1/notifications` (sunucu metinleri), açılınca `read-all`, kaydırarak silme `DELETE /v1/notifications/:id` (`lib/domain/notification/notifications_repository.dart`). Profildeki Bildirimler satırında okunmamış rozeti (`unread-count`, dönüşte tazelenir). Sayfalama henüz yok.
- Cihaz kaydı: açılışta (oturum varsa) ve her girişte `PUT /v1/devices/current` (installId, platform, sürüm, OS, saat dilimi, dil; `AuthRepository.registerDevice`, `AuthBloc`). Push token henüz yok: `firebase_messaging` eklenince aynı uca `pushToken`/`pushEnabled` ile gönderilecek (`onTokenRefresh`'te de).
- Hesabı sil: Profili Düzenle en altında (`ProfileDangerCard`, `ConfirmDialog`).
- Yerel ayar: `dart_defines/local.json` (`API_BASE_URL=http://localhost:3000/v1`); varsayılan prod `https://mochifast-api.fly-work.com/v1`.

Uçtan uca doğrulanan: misafir girişi → `/v1/user/me`, `/v1/user/progress` 200. **Onboarding gönderimi henüz simülatörde denenmedi.**

Kalan (önerilen sıra; her birinde sahte veriyi kaldır, gerçek uca bağla):

1. [ ] Onboarding'i simülatörde sonuna kadar dene; `POST /v1/user/onboarding` 200 olmalı.
2. [ ] Ana sayfa → `GET /v1/user/summary` (home_bloc + home kartları; doküman 13 §4 tablosu).
3. [ ] Oruç: `GET /v1/fasts/active`, `POST /v1/fasts`, `POST /v1/fasts/:id/finish`, `GET /v1/plans/current`, evreler `GET /v1/catalog/stages`.
4. [ ] Su / kilo / adım / uyku / öğün / açlık ekranları (trackers, meals, hunger uçları).
5. [ ] Sohbet (SSE) `/v1/chat/*`; fotoğraf analizi `/v1/meals/photo-analyses`.
6. [ ] Mochi World `GET /v1/world`, challenge'lar; profil; bildirim kutusu + rozet ✓ (sayfalama kaldı); FCM token kaydı `PUT /v1/devices/current`.
7. [ ] RevenueCat: `Purchases.logIn(userId)`, paywall, `POST /v1/subscription/sync`.
8. [ ] Sağlık verisi ve AI işleme için açık rıza ekranları; engeller çoklu seçim; `requiredConsents` yeniden onay ekranı.
9. [ ] Liste yanıtları için `PagedResponse` (`data.items` + `data.pageInfo`).
