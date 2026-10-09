# HANDOFF — MochiFast (devam edecek geliştirici / yapay zekâ için)

Son güncelleme: 2026-10-08. Bu dosya, işi yarıda devralan birinin bağlamı hızla kurması için yazıldı.
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
- **Asla commit etme / içeriğini yazdırma:** `.env`, `deploy/deploy.env`, `deploy/backup.env`, `loadtest/users.json`.
- **Tek ortam dosyası `.env`** (şablon `.env.example`; kullanıcı kararı 2026-10-08). `.env.production` yok: sunucunun `.env`'ini kullanıcı sunucuda kendisi tutar, deploy env göndermez.
- `.env` dosyalarına yeni anahtar eklerken yalnızca **eksik** anahtarı ekle, değerleri ekrana basma.
- **Hesap birleştirme yok, misafir kalıcı** (kullanıcı kararı 2026-10-08): misafir cihazda ayrı, kalıcı bir hesaptır; başka hesaba
  geçişte veri taşınmaz, misafir silinmez (yalnızca oturumu kapanır). Misafirler süreyle de silinmez (90 gün kuralı kaldırıldı).
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
Son backend commit'leri: `d345846` (AI: Anthropic → OpenAI), `0b50836` (misafir sırrı), `3b20902` (kullanılmayan şablon), `9ec59e5` (günün ipucu),
`bf58398` (refresh aile limiti), `d99a0df` (Fast Forecast), `a14d31a` (bu dosya), `4d03412` (eski önek'siz yollar silindi),
`df0d871` (F11 sertleştirme), `0ad5487`, `77748b7` (F10), `d85c836`, `3d1e84c` (F9).
Testler: 43 dosya / 385 test geçiyor (2026-10-08). Uzak DB migration'ları 0021'e kadar uygulandı; seed güncel.

Modüller (`src/modules`): auth, user, account (silme/dışa aktarma/saklama), admin, devices, catalog, plans, fasting,
stats, trackers (kilo/su/adım/uyku), meals, hunger, ai (fotoğraf analizi, OpenAI vision), chat (OpenAI, SSE), gamification
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
6. [x] (2026-10-08) **AI maliyet hatası:** OpenAI yanıtındaki tarihli model adı (`gpt-4o-2024-08-06`) fiyat tablosunda
       bulunmuyordu → maliyet 0, günlük bütçe sigortası çalışmıyordu. `src/modules/ai/ai.cost.js` `priceFor` tarih ekini atar.
7. [x] (2026-10-08) **Anthropic kaldırıldı:** `src/infra/anthropic.js`, `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`/`AI_CHAT_MODEL`/
       `AI_VISION_MODEL`/`AI_SERVER_FALLBACK`; dokümanlar (02, 06, 07, 09, 14, 15, README) OpenAI'ye göre güncellendi.
8. [x] (2026-10-08) **Seed `features.chatQuota: true`** (üretim güvenli); yerelde kota `.env` `AI_CHAT_QUOTA_ENABLED=false` ile kapalı.
       `/v1/user/me` `entitlements` artık premium'da `["premium"]`.
9. [x] (2026-10-08) **Hesap birleştirme YOK, misafir kalıcı (kullanıcı kararı):** misafir oturumu varken başka hesaba bağlı
       Apple/Google ile girişte doğrudan o hesaba geçilir (`auth.service.js` `register`, outcome `switched`); misafirin verisi
       taşınmaz, misafir **silinmez** (yalnızca oturumları iptal; aynı installId + misafir sırrıyla yeniden açılır). `mergeGuest`,
       `mergedFromGuest`, `ACCOUNT_LINK_CONFLICT`, `guest-merge.js`, `retireGuest`, saklama işindeki inaktif/kapanan misafir silme
       (90/30 gün) kaldırıldı. Bunları yeniden ekleme.
10. [ ] (Opsiyonel) widget yenilemesi için sessiz push (F9), ürün analitiği (PostHog/Amplitude, rıza kontrollü).
11. [ ] (E-posta kanalı gelince) 24 ay inaktif kayıtlı hesap uyarısı + silme (06 §8.4).

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
- Cihaz kaydı: açılışta (oturum varsa) ve her girişte `PUT /v1/devices/current` (installId, platform, sürüm, OS, saat dilimi, dil; `AuthRepository.registerDevice`, `AuthBloc`). Push: `firebase_messaging` + `lib/domain/notification/push_service.dart`; izin onboarding sonunda (GoodCompany) istenir, token ve `pushEnabled` aynı kayıtla gider, `onTokenRefresh`'te tekrar kaydedilir. Yeni native eklenti → ilk çalıştırmada `pod install` (`LANG=en_US.UTF-8`). Gerçek push testi fiziksel cihaz + APNs key ister (Firebase'e yüklendi). Dokunma: `lib/core/push/push_open_handler.dart` (`main.dart`'ta başlar) → `POST /notifications/:id/read` + `deepLink` (`fastingapp://water` → `/water`; sekmeler `go`, diğerleri `push`; soğuk açılışta oturum + splash beklenir). Ön planda: iOS sistem afişi (`setForegroundNotificationPresentationOptions`), Android uygulama içi şerit (`AppSnackbar`). Android kanalları `MainActivity.kt`'da (paket yok): `default` (yüksek) ve `quiet` (düşük, sessiz); manifest varsayılan kanal `default`. Android debug derlemesi doğrulandı (`flutter build apk --debug`).
- Hesabı sil: Profili Düzenle en altında (`ProfileDangerCard`, `ConfirmDialog`).
- Profil: global `ProfileBloc` (`lib/presentation/profile/bloc/`, singleton) — splash'te (oturum + onboarding bitmişse) ve
  home rotası açılırken ısıtılır (`ProfileStarted`, yüklüyse dokunmaz), çıkışta `ProfileCleared` (`AuthBloc`). Veri:
  `lib/domain/profile/profile_repository.dart` (`GET /user/me` ad+avatar, `GET /user/profile`, `GET /plans/current` — etkin plan,
  yoksa bekleyen premium plan). Profili Düzenle `BlocConsumer` ile anında açılır (setState yok); düzenlemeler event → iyimser
  güncelleme, hata olursa eski değer + `ProfileSaveError` snackbar; yazmalar sıralı. Kilo/hedef/plan sonrası `HomeRefreshRequested`;
  premium plan 402 → paywall. Profil sekmesi başlığı: ad/avatar `ProfileBloc`, seri `HomeBloc`; adsızsa "Misafir" (`profile.guest_name`).
- Çıkış / hesap silme → `RoutePaths.login` (eski `WelcomeView` iskeleti ve `/welcome` rotası silindi). Girişte onboarding'i
  bitmemiş hesap (ör. çıkış sonrası yeni misafir) `/onboarding`'e gider (`WelcomeBloc._complete`, splash ile aynı kural).
- Misafir oturumu varken başka hesaba bağlı Apple/Google ile giriş: sunucu doğrudan o hesaba geçer (birleştirme yok, diyalog yok).
  `AuthBloc._onLoggedIn` kullanıcı değiştiyse ana sayfa + profil önbelleğini temizler. Giriş hatalarında yalnızca sunucu mesajı gösterilir.
- Yerel ayar: `dart_defines/local.json` (`API_BASE_URL=http://localhost:3000/v1`); varsayılan prod `https://mochifast-api.fly-work.com/v1`.

Uçtan uca doğrulanan: misafir girişi → `/v1/user/me`, `/v1/user/progress` 200. **Onboarding gönderimi henüz simülatörde denenmedi.**

Backend'de commit edilmemiş değişiklik var (2026-10-08, OpenAI geçişinin devamı: `src/infra/openai.js` signal/timeout, chat servisi, media pipeline, `prompts/coach_mochi.v1.md`, `seeds/app_config.json`). Kullanıcı commit edecek; üzerine yazma. Testler buna uyarlandı (commit edilmedi): kota testleri `setFeatureFlag(ctx, 'chatQuota', true)` ile kotayı açar (`test/helpers/app.js`; seed'de `features.chatQuota: false`), kapalı kota için ayrı test var; lint/prettier temiz.

- Oruç + plan + senkron düzeltmeleri (2026-10-08, simülatörde denenmedi; API yükleri curl ile doğrulandı):
  - Yazma sonrası tazeleme: `lib/core/sync/data_sync.dart` `DataSync.afterWrite({profile})` → `HomeRefreshRequested`
    (+ `ProfileStarted(force)`). Oruç başlat/bitir/plan, su ekle/sil, kilo/hedef kilo, adım, öğün (fotoğraf/elle), açlık kaydı çağırır.
    Hata olursa sahte yerel değer yok: `AppSnackbar.showError`.
  - Orucu bitirme: `lib/presentation/fasting/fasting_finish_flow.dart` (`FastingFinishFlow.open`, sunucu saatiyle); eski
    `FastingEndSignal` silindi (zorlanma akışı ve öğün kaydından "orucu bitir" artık gerçekten bitirir).
  - Plan: `FastingRepository.setCurrentPlan` + `FastingSessionCubit.changePlan` (402 → paywall → tekrar). Oruç sekmesi plan
    sayfası ve Planlar sekmesi (plan detayı `PlanSelection`, özel yemek penceresi → `timing: custom`) sunucuya yazar; seçili kart
    `PlansCatalog.forPlan(planCode, timing)` ile sunucudaki etkin plandan. `UserFastingPlan.timing` parse edilir. Katalog hâlâ statik.
  - Oruç sekmesi: su/adım/kilo/açlık kartları ve seri `HomeBloc` özetinden; kum saati butonu "Orucu şimdi başlat"; sahte
    "09:34/20:34" yerine "–"; Mochi kartında başlangıç/bitiş (yeme penceresi sonu/başı) düzeltildi; widget bitişi `plannedEndAt`.
  - Tarih seçiciler sunucu kuralıyla: en fazla 7 gün geri, gelecek yok (başlat sayfası, bitirme ekranı).
  - Kilo kalemi (ana sayfa, oruç sekmesi): `lib/presentation/home/weight_entry_flow.dart` → `POST /weights` (önceden sonuç atılıyordu).
  - Su hedefi ve bardak boyu: `TrackersRepository.updateGoals` → `PATCH /user/goals`.
    Denetim (2026-10-08) kalanlar: Planlar kataloğu `GET /catalog/plans`'tan değil; oruç geçmişi ekranı yok; zorlanma olayları
    gönderilmiyor; günün ipucu (`/fasts/daily-tip`) kullanılmıyor; forecast grafiği örnek eğri; hedef ekranları (adım, uyku, kalori,
    protein) yok; adım elle giriş kontrolü (`_StepsControls`) ekranda değil; uyku kaydı yok; açlık geçmişi özeti sabit; hızlı kcal ve
    öğün silme yok; Mochi World, challenge kartı, insights statik; profil bildirim/sağlık anahtarları ve bildirim ayarları
    (`/user/settings`) bağlı değil; dil seçimi çoğu dilde çalışmıyor; rıza ekranları yok; `/app/config` (zorunlu güncelleme) yok.

Kalan (önerilen sıra; her birinde sahte veriyi kaldır, gerçek uca bağla):

1. [ ] Onboarding'i simülatörde sonuna kadar dene; `POST /v1/user/onboarding` 200 olmalı.
2. [~] Ana sayfa → `GET /v1/user/summary`: `HomeBloc` tek çağrı (`lib/data/model/user/home_summary.dart`, `UserRepository.getSummary`), hata → `HomeError`, yükleniyor → shimmer (`lib/core/widgets/app_shimmer.dart`). Su/adım, kilo, oruç kartı (activeFast + serverTime), hafta şeridi (week), son öğün kartı (lastMeal) gerçek veri. **Kalan:** `home_challenge_card` (modelde `featuredChallenge` yok; alanı ekle + join).
3. [x] Oruç (2026-10-08, simülatörde denenmedi): `lib/domain/fasting/fasting_repository.dart` (`/fasts/active`, `POST /fasts`, `/fasts/:id/finish`, `/plans/current`, `/catalog/stages`) + `lib/presentation/fasting/bloc/fasting_session_cubit.dart`; oruç, bitirme, vücut durumu ekranları ve `HomeBloc` bu cubit'i kullanır.
4. [x] Tracker ekranları (2026-10-08, simülatörde denenmedi): `lib/domain/trackers/trackers_repository.dart` (su `/water`, kilo `/weights*`, adım `/steps`, uyku `/sleep/summary`) → su, kilo geçmişi, adım, uyku ekranları; `lib/domain/hunger/hunger_repository.dart` (`/hunger-checkins*`) → açlık akışı; `lib/domain/nutrition/` (`/meals*`, `/nutrition/day|week`) → öğün kayıtları, kalori, protein. `steps_view.dart` içindeki `_StepsControls` artık kullanılmıyor (analyze uyarısı) — sil ya da bağla.
5. [x] Sohbet + fotoğraf analizi (2026-10-08, simülatörde denenmedi): `lib/domain/chat/chat_repository.dart` (`/chat/conversations*`, SSE) → `ChatSessionCubit`; `MealsRepository.analyzePhoto/pollAnalysis` (`/meals/photo-analyses`) → kalori sonuç ekranı.
6. [ ] Mochi World `GET /v1/world`, challenge'lar; profil; bildirim kutusu + rozet ✓ (sayfalama kaldı); FCM token kaydı `PUT /v1/devices/current`.
7. [~] RevenueCat (2026-10-08, istemci kodu hazır; cihazda satın alma denenmedi): `lib/domain/revenue_cat/revenue_cat_service.dart` — açılışta `configure` (önbellekteki kullanıcı UUID'si, yoksa anonim; `main.dart`), her girişte `logIn` (`AuthRepository._save`, onboarding misafiri dahil), çıkışta `logOut` (`endLocalSession`), `POST /v1/subscription/sync` (oturum yoksa çağrılmaz, 1 dk kısma; 503'te CustomerInfo'ya düşer), `isPremium` ValueNotifier, RevenueCat Paywall (`default` offering, kapatma düğmeli), geri yükleme (Profil → "Satın alımları geri yükle"). Anahtarlar `lib/core/utils/constants/revenue_cat_constants.dart` (public SDK anahtarları; `REVENUECAT_IOS_KEY`/`REVENUECAT_ANDROID_KEY` define'ı ezer), entitlement `mochifast_pro` (sunucu `.env` `REVENUECAT_ENTITLEMENT=mochifast_pro` yapıldı; kod varsayılanı testler için `premium` kaldı). Paywall tetikleri: ana sayfa ve oruç ekranı "Premium" hapı, Profil premium kartı (premium'da gizli; başlık rozeti artık gerçek), kilitli planlar (Planlar sekmesi + oruç plan sayfası; premium'da kilit kalkar), sohbet ve fotoğraf `QUOTA_EXCEEDED` + `upgradeAvailable` / `PREMIUM_REQUIRED` (`RevenueCatService.needsUpgrade`). Sohbet akış isteğinde hata gövdesi artık okunuyor (önceden kod kayboluyordu). Android `MainActivity` → `FlutterFragmentActivity` (Paywalls için). **Kullanıcıda kalan:** `.env`'de `REVENUECAT_SECRET_API_KEY` (sk_…) boş (`REVENUECAT_WEBHOOK_AUTH` girildi, sunucu `.env`'ine de aynısı); RevenueCat panelinde webhook `https://mochifast-api.fly-work.com/v1/webhooks/revenuecat` + Authorization alanına `REVENUECAT_WEBHOOK_AUTH`'un birebir aynısı (sunucu ham başlığı tam eşleşmeyle karşılaştırır; `Bearer` öneki eklenmez); `default` offering'e paket + Paywall tasarımı; App Store Connect / Play Console ürünleri; sandbox hesapla fiziksel cihazda satın alma testi. Ayrıca `PUT /plans/current` istemcide henüz yok (seçilen premium plan sunucuya gitmiyor).
8. [ ] Sağlık verisi ve AI işleme için açık rıza ekranları; engeller çoklu seçim; `requiredConsents` yeniden onay ekranı.
9. [ ] Liste yanıtları için `PagedResponse` (`data.items` + `data.pageInfo`).
