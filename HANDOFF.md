# HANDOFF — MochiFast (devam edecek geliştirici / yapay zekâ için)

Son güncelleme: 2026-10-12. Bu dosya, işi yarıda devralan birinin bağlamı hızla kurması için yazıldı.
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
- **AI bütçe sınırı yok** (kullanıcı kararı 2026-10-12): günlük maliyet kapısı kaldırıldı; maliyet yalnızca `ai_usage_daily`'de kaydedilir. Geri ekleme.
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
Son backend commit'leri: `eb9f72b` (reasoning_effort yalnızca reasoning modellerine, bütçe kapısı kaldırıldı), `1858ffb` (özet `plan` = tam plan DTO'su), `fd0b95d`/`d345846` (AI: Anthropic → OpenAI), `0b50836` (misafir sırrı), `3b20902` (kullanılmayan şablon), `9ec59e5` (günün ipucu),
`bf58398` (refresh aile limiti), `d99a0df` (Fast Forecast), `a14d31a` (bu dosya), `4d03412` (eski önek'siz yollar silindi),
`df0d871` (F11 sertleştirme), `0ad5487`, `77748b7` (F10), `d85c836`, `3d1e84c` (F9).
Testler: 43 dosya / 386 test geçiyor (2026-10-12). Uzak DB migration'ları 0021'e kadar uygulandı; seed güncel.

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
       bulunmuyordu → maliyet 0 kaydediliyordu. `src/modules/ai/ai.cost.js` `priceFor` tarih ekini atar.
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
- Oruç ekranı Forecast kartı → `GET /v1/fasts/forecast` (`lib/domain/fasting/forecast_repository.dart`); güven %, en zor saat, risk aralığı, oruç süresi gerçek; veri yoksa kart gizli. Grafik eğrisi hâlâ örnek. Günün ipucu → Mochi plan kartı insight kutusu (`GET /v1/fasts/daily-tip`, `FastingRepository.getDailyTip`; yoksa yerel çeviri).
- Bildirim kutusu (Profil → Bildirimler) → `GET /v1/notifications` (sunucu metinleri, `cursor`/`pageInfo` sayfalama), açılınca `read-all`, kaydırarak silme `DELETE /v1/notifications/:id` (`lib/domain/notification/notifications_repository.dart`). Profildeki Bildirimler satırında okunmamış rozeti (`unread` notifier + `refreshUnread`).
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

OpenAI geçişi commit edildi (`d345846`, `fd0b95d`). Kota testleri `setFeatureFlag(ctx, 'chatQuota', true)` ile kotayı açar (`test/helpers/app.js`).

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

## 7. Denetim 2026-10-12 — iş listesi (Cursor agent işinin incelemesi sonrası)

Üç inceleme yapıldı (backend, istemci↔sunucu sözleşmesi, sahte veri/senkron/performans). Sırayla ilerle; bitirince `[x]`.
Flutter değişiklikleri commit edilmez (kullanıcı eder).

### 7.1 Kritik

- [x] AI rızası: sessiz grant kaldırıldı → `AiConsent.ensure` + `AppDialogs.showAiProcessingConsent` (sohbet gönderimi /
      kalori kamerası); `GET/POST /user/consents` (`aiProcessing`).
      Onboarding gövdesi artık `consents.aiProcessing` göndermez (önceden `true` gidiyordu → diyalog hiç çıkmazdı).
      HealthKit yalnızca okuma (`NSHealthUpdateUsageDescription` kaldırıldı, `HealthDataAccess.READ` açık).
- [x] Geçici ağ hatası oturumu kapatıyordu → `expired_token_interceptor.dart`: refresh yalnızca 400/401/403/410 ile reddedilirse oturum biter; ağ/5xx/429'da istek hatayla döner.
- [x] `safetyAcknowledged` gönderilmiyordu (20_4, omad, 5_2 seçilemiyordu) → `lib/domain/fasting/plan_safety.dart` (sabit liste; katalog bağlanınca oradan), `AppDialogs.showPlanSafetyAck` (7 dil `plans.safety_ack_*`), `plan_change_flow.dart` ve Profili Düzenle plan seçimi önce uyarı gösterir, iki repository de alanı gönderir.
- [x] Özet `plan`'ında `timing` yoktu, `applyFromSummary` planı eziyordu → backend `1858ffb`: `/user/summary.plan` artık `/plans/current` ile aynı DTO (`userPlanSchema`).
- [x] Fotoğraf analizine `reasoning_effort` gidiyordu (gpt-4o 400) → `OPENAI_VISION_REASONING_EFFORT` ayrı; `reasoningParam()` yalnızca o-serisi/gpt-5'e gönderir.
- [x] Bütçe kapısı kaldırıldı (`assertBudget`, `ai.daily_budget_usd` seed, `todaysCostMicroUsd`); seed `ai.pricing`'den eski `claude-opus-5-5` silindi.
      Kullanıcıda: canlı DB `app_config.ai.pricing`'e `gpt-4o` fiyatını eklemek (seed mevcut anahtarı güncellemez; `--overwrite-config` tüm config'i ezer, dikkat).
- [ ] (En sona bırakıldı, kullanıcı kararı) Deploy: `deploy.sh` rsync `.env.example`'ı göndermiyor ama dokümanlar sunucuda `cp .env.example .env` diyor.
- [x] Su senkronu hata sonrası hizalanmıyordu (`_waterFlushing` açıkken `loadWaterDay` dönüyordu) → `water_view_mixin.dart` catch'te bayrak önce kapanır.
- [x] Oruçta plan değişince önce oruç iptal ediliyordu → `FastingSessionCubit.changePlanWhileFasting`: önce plan (`_putPlan`, paywall/ret olursa oruç bozulmaz), sonra iptal (+ aynı başlangıçla yeniden başlat), tek `refresh` + tek `afterWrite`.

### 7.2 Sözleşme uyumsuzlukları

- [x] `PUT /steps/:date` haftayı ezmesi + yarışan PUT'lar (bkz. 7.5 adımlar).
- [x] `PATCH /user/onboarding` 404: çağıran "dil seviyesi" ekranı şablondan kalma ölü koddu (hiçbir akış açmıyordu) →
      `language_level` ekranı/bloc/rota/DI ve `UserRepository.saveAnsweredQuestions` silindi.
- [x] Su: özel bardak en fazla 5 + 50–2000 ml (`water_reminder_view.dart`, snackbar); birim/hatırlatma/özel bardaklar artık
      yüklenir (`TrackersRepository.getWaterPrefs`: `/user/me.units`, `/user/settings`, `/user/goals`).
- [x] Kilo diyaloğu 30–300 kg (profil ve tartı aralıklarının ortak kısmı), dışında satır içi uyarı.
- [x] Sohbet SSE `safety`: `message.created/completed` okunur; `urgent` ise yanıtın altında yardım kutusu (`chat.safety_urgent`),
      geçmişten açılan konuşmada da. Akış ortasında hata olursa (kullanıcı mesajı sunucuda saklıysa) konuşma yeniden yüklenir.
- [x] Hatalar boş durum gibi gösterilmiyor (öğün kayıtları, uyku, açlık geçmişi); `HomeBloc` `on Object`.
- [x] Oruç ekranı çift hata snackbar'ı: ekran dinleyicisi hata göstermez, işlemi başlatan gösterir.
- [x] Paywall: satın alma sonrası sunucu henüz premium demese de yerel premium düşmez (`sync(keepPremium:)`, 3/10/30 sn yeniden
      dene; `RevenueCatService.applyServerPremium` özetten gelen `false`'u bu sırada yok sayar).
- [x] Açlık belirti eşlemesi: "halsizlik" → `lowEnergy` (önceden `nothingPhysical` = duygusal puan), baş ağrısı/uykusuzluk
      karşılıksız; istek yalnızca 3. sorudaki gerçek `bodyNotices`'u gönderir (belirtiler ayrıca `symptoms` ile gider).
- [x] Backend: hesap değiştirmede misafirin push token'ları silinir (`ddd6a04`).
- [x] Backend küçükler (2026-10-12): üretimde `AI_CHAT_QUOTA_ENABLED=false` → process başlamaz; `MEDIA_DRIVER=bunny`
      iken public zone (`BUNNY_STORAGE_ZONE` / `PASSWORD` / `PULL_ZONE_HOST`) zorunlu; CONTRIBUTING + docs 09/12 Anthropic
      kalıntıları OpenAI'ye çekildi; `createVisionClient` birim testleri (`test/unit/openai.test.js`) + `image_url.detail: high`.
- [x] Avatarlar public zone'da `avatars/<ownerKey>/<mediaId>_*.webp` (kullanıcı kararı 2026-10-12; önceden `u/<key>/avatar/`).
      Hesap silme public `avatars/<key>/` önekini de siler. Eski avatarlar DB'deki yollarıyla çalışmaya devam eder.
- [x] Android `minSdk = 26` (`health` / Health Connect paketi zorunlu kılıyor; önceden `flutter build apk` kırıktı).
      Kullanıcıda: Apple Developer'da App ID'ye HealthKit capability; Play Console'da Health Connect izin beyanı.

### 7.3 Senkron

- [x] Yenileme: `lib/core/sync/app_sync_scope.dart` (`AppSyncScope`, `app.dart` builder'ında) — ön plana dönüş (30 sn kısma, gün
      değiştiyse hemen), gece yarısı zamanlayıcısı ve `ConnectivityService.reconnects` → `HomeRefreshRequested` (+ beslenme bayat).
      Yalnızca `HomeBloc` en az bir kez yüklendiyse çalışır. Özet oruç durumunu cubit'e zaten taşır.
- [x] Ana sayfa oruç sayacı: `home_fasting_card.dart` kalan süreyi `FastingSessionCubit.state.liveMetrics`'ten (fetchedAt + saat farkı) alır.
- [x] `HomeBloc` yarışı: uçuşta tek istek + en fazla bir "sonra tekrar" (`_inFlight/_again`), `HomeCleared` sonrası eski yanıt
      atılır (`_epoch`), `on Object` (ayrıştırma hataları da `HomeError`). `afterWrite` yağmuru bu sayede tek isteğe katlanır.
- [x] Oruç widget'ı: yayın mantığı `lib/core/home_widgets/fasting_widget_publisher.dart`; `AppSyncScope` cubit'te oruç/plan/yeme
      penceresi değişince yayınlar (oruç ekranı açık olmasa da). Widget haftası sahte diziden kurtuldu: özet `week`'ten
      (`FastingWidgetSync.saveWeek`, hedef = plan süresi), hafta dönünce sıfırlanır (`fasting_week_start`).
- [x] Su widget'ı: `water_date` anahtarı (gün dönünce eski toplam 0 sayılır), varsayılan 100 → 0, `updateToday` ile özetten
      güncellenir, su ekranında geçmiş gün gezilirken widget yayınlanmaz.
- [x] Beslenme önbelleği yazmada silinmiyor, bayat işaretleniyor (`invalidate`); çıkış/hesap değişiminde `clear()` (`AuthBloc`).
- [x] Çift istekler: oruç sekmesi `initState` yalnızca veri yoksa / 1 dk'dan eskiyse tazeler; `startFast` POST yanıtını kullanır;
      bitirme ekranı kiloyu `HomeBloc`'tan okur; forecast kartı oruç başlayınca/bitince yeniden yüklenir.
- [x] Soğuk açılış push: sabit 900 ms yerine router splash'ten çıkana kadar beklenir (`push_open_handler.dart` `_leftSplash`).
- [x] `AuthCheckRequested` yalnızca bir kez (`MyApp` `initState`). `X-Timezone` 10 dk'da bir yeniden okunur.
- [x] Ana sayfa kilo iyimser: `HomeWeightOptimistic` (özet dönene kadar kart güncel; hata → yenile).
- [x] Okunmamış bildirim rozeti: `NotificationsRepository.unread` (`ValueNotifier`) + `refreshUnread`;
      `AppSyncScope` ön plana / yeniden bağlanınca; profil dinler; push okuma/ön plan + `markRead`/`markAllRead`/`remove`
      günceller; çıkışta `clearUnread`.

### 7.4 Loading / performans

- [x] Splash: min. 900 ms (logo animasyonu), özet en fazla 2 sn beklenir; 6 sn auth yedeği (girişliyi login'e atıyordu) kaldırıldı.
      Son özet cihazda (`SharedPrefManager.homeSummary`, `serverTime` atılmış, yalnızca bugün + aynı kullanıcı; çıkışta silinir):
      `HomeBloc` önce onu çizer, ağ yanıtıyla sessizce yeniler. Veri değişmediyse (`UserRepository.lastSummaryUnchanged`) emit yok.
- [x] `withLoading(showAfter:)`: kısa işlerde dialog hiç açılmaz (plan değişimi, BuildingPlan 300 ms). Paylaş'ta loading kaldırıldı.
      Oruçta plan değişiminde son `refresh` dialog'u bekletmez.
- [x] İskelet yalnızca ilk yükte: öğün kayıtları gün önbelleği (`MealsRepository.cachedDay`, çıkışta temizlenir), açlık geçmişi bir
      kez yüklenir + istemcide süzülür (kayıt saati artık görünür), vücut geçmişi aralık önbelleği + diğer aralıklar önceden yüklenir.
      Hatalar boş liste yerine snackbar.
- [x] Su ekranı: sayfa yalnızca dolum/kutlama animasyonunda kurulur; dalga+balon, maskot salınımı ayrı `AnimatedBuilder` +
      `RepaintBoundary`; her balon kendi katmanında (blur her karede yeniden çizilmez).
- [x] Oruç sekmesi: saniyelik sayaç `ValueNotifier` → yalnızca yay/sayaç bölümü yeniden kurulur.
- [x] Ana sayfa sıvı çubuğu 2 tur dalgalanıp durur (değer değişince tekrar), `RepaintBoundary`; sohbet rozeti 4 nabız.
- [x] Widget'lar: dakikalık zamanlayıcı kaldırıldı; durum değişince + uygulama arka plana geçerken (`AppSyncScope` `onHide`)
      çizilir. Açılışta dil senkronu resim üretmez (yalnızca etiket). Not: geri sayım resmin içinde; uygulama kapalıyken widget
      metni ilerlemez (native tarafın `fasting_start_ms/end_ms` ile kendisi sayması ayrı iş).
- [x] Açılış: Firebase/localization/prefs/manifest paralel; uzak görsel senkronu ilk kareden 3 sn sonra. `appImage` genişlik
      biliniyorsa `width × dpr × 2` ile çözer (cover/fill/fitHeight hariç).
- [x] Ağ: erişim token'ı bellekte (`AuthCacheManager`), debug `LogInterceptor` gövde/başlık basmaz.
- [x] Bildirim listesi sayfalama (`cursor`/`pageInfo`, scroll + kısa ekranda doldurma).
- [x] Refresh sonrası ayrı Dio: `ExpiredTokenInterceptor` içinde `_refreshDio` (yalnızca
      `/auth/refresh`) + `_retryDio` (401 sonrası tekrar); ana interceptor kuyruğuna girmez;
      FormData `clone()` ile yeniden denenir.
- [x] Mochi World: `_GlassCard` BackdropFilter kaldırıldı (yarı saydam dolgu); precache yalnızca
      görünen ada + immersive girişte demo sahneleri.

Not (2026-10-12): yerel `npm run worker:dev`'in alt süreci düşmüştü (`--watch` ebeveyni ayakta, çocuk yok) → zamanlanmış işler
9 Ekim'den beri çalışmamış (72 sa üstü oruçlar açık kalmış). `touch src/worker.js` ile yeniden başlatıldı. `pgrep -fl src/worker.js`
iki satır (watch + node) göstermeli.

### 7.5 Hâlâ sahte veri

- [x] Challenge kartı: `HomeSummary.featuredChallenge` (`lib/domain/gamification/challenges_repository.dart`), sayı/avatarlar sunucudan,
      Katıl → `POST /challenges/:code/join` (402 → paywall), katıldıysa "x/y tamamlandı"; challenge yoksa kart gizli.
- [x] Metabolik kart gizlendi (değerler sabitti; faz 7). Kilo kartı veri yoksa "–" (sahte 70 kg kalktı).
- [x] Plan kataloğu: `PlanCatalogRepository` (`/catalog/plans`, splash'te yüklenir) → `PlansCardData.isLocked` ve
      `planRequiresSafetyAck` sunucu bayrağından (yüklenemezse yerel yedek). Kart tasarımı/satırlar istemcide kaldı.
- [x] Açlık: hafta şeridi `/hunger-checkins/summary.week`; değerlendirme hatasında uydurma sonuç yerine snackbar; sonuç ekranı
      sunucu `recommendations` + `safetyFlag` uyarısı (`hunger_result_page.safety_note`).
- [x] Adımlar: elle giriş (`_StepsControls`) ekranda (yalnızca bugün), PUT'lar 600 ms birleştirilir, yanıt haftayı ezmez, hata →
      snackbar + yeniden yükleme; ekran özetten tohumlanır. HealthKit/Google Fit hâlâ yok.
- [x] Uyku: başlıkta "+" → yatış/kalkış (`AppDialogs.showSleepTime`) → `POST /sleep`; hafta etiketleri tarihten (son 7 gün).
- [x] Kalori: elle kcal → "X kcal ekle" → `POST /meals` (`source: quickKcal`).
- [x] Sohbet önerileri `/chat/suggestions` (dile göre önbellek). SSS `/catalog/faq` (`ContentRepository`).
- [x] Zorlanma: ipucu seçilince `POST /fasts/:id/struggles` (oruç yoksa `/struggles`) — forecast "en zor saat" bunlardan.
      Metinler `GET /catalog/struggle` (`ContentRepository.struggle`); yüklenemezse yerel çeviri.
- [x] Profil push / sağlık anahtarları `GET/PATCH /user/settings` (iyimser, hata → geri al).
- [x] Mochi World `/v1/world` (`WorldRepository`): bölgeler (seviye sunucudan), sağlık, dünya ilerlemesi, seviye, hafta.
      Not: son seviyede hedef = en büyük eşik ("12.5/10 kg" gibi aşılmış görünebilir).
- [x] Insights: kategori başlık/açıklama `/insights/categories`, detay `/insights/articles?category=` → `/articles/:slug`
      (kicker, başlık, alıntı, ipucu, bölümler). Görseller/renkler yerel; yüklenene kadar yerel metin.
- [x] Forecast grafiği: eğri şablonu zorluğa göre, tepe `toughestAt` saatine kaydırılır (saatlik risk verisi sunucuda yok).
- Pazarlama sayıları (GoodCompany "2M+ / 4.8", premium kartı "200K+") **bilinçli olarak sabit çeviri metni** (kullanıcı kararı
  2026-10-12); `/app/config.marketing`'e bağlama.
- [x] Öğün silme: meal detail → onay diyaloğu → `DELETE /meals/:id` + gün önbelleği / `DataSync`.
- [x] Oruç geçmişi: Profil → `FastingHistoryView` (`GET /fasts` + `/fasts/stats`).
- [x] HealthKit / Health Connect: `HealthSyncService` → `POST /steps/sync` (iOS `appleHealth`,
      Android `googleFit` kaynağı; Google Fit API değil Health Connect). Profil anahtarı izin ister;
      `AppSyncScope` + adım ekranı senkronlar.
- Onboarding seçenekleri **bilinçli olarak uygulamada sabit** (kullanıcı kararı 2026-10-12): kodlar sunucu enum'larıyla birebir,
  `/catalog/onboarding-options` bağlanmayacak (ilk açılışa ağ bağımlılığı eklemesin).

## 8. Mantık denetimi 2026-10-12 (ikinci tur) — iş listesi

Üç inceleme + oruç sekmesi. Sırayla ilerle; bitirince `[x]`. Dosya:satır bulguların ilk görüldüğü yer.

### 8.1 Oruç sekmesi

- [x] At nalı aşamaları: `lib/presentation/fasting/fasting_arc_stages.dart` (saf mantık + `test/presentation/fasting_arc_stages_test.dart`).
      Vücut: `startHour` (0,2,5,8,12,16,18,24,48) `/ hedef saat` konumunda, hedefe kadar olanlar; yakın olanlar seyreltilir
      (min. 0.11). Yeme: sunucu `eatingStage` kuralının sınırları (ilk %20 / en az 30 dk, son 60 dk). Ulaşılan ikon renkli,
      mevcut aşama hafif büyük, gelmeyen gri. Metin/görseller yerel 7 dil (`body_status.*`, `eating_window.*`).
- [x] Üst kart mevcut aşamayı gösterir (başlık + açıklama + görsel, aşama değişince geçiş animasyonu).
- [x] Sekme durumu gerçek duruma bağlı: oruç → vücut, yeme penceresi → öğün, ikisi yok → vücut (boşta: "Oruca hazır mısın?",
      %0, gri, yalnızca başlat). Oruçta öğün sekmesi "Öğün vakti henüz gelmedi" önizlemesi. Butonlar sekmeye değil gerçek
      oruca bağlı (oruç yokken "erken bitir / zorlanıyorum" yok). Kum saati kısayolu yalnızca oruç yokken.
- [x] Ana sayfa oruç kartı: hedef geçince "Hedefe ulaştın" + toplam süre ileri sayar; yeme penceresinde başlık
      "Öğün penceresi"; pencere sıfıra inince bir kez özet yenilenir.

### 8.2 Yüksek

- [ ] Çıkış / hesap değişiminde sohbet sıfırlanmıyor: B kullanıcısı A'nın konuşmasını görür, mesajı A'nın konuşmasına gider
      (`auth_bloc.dart` `_clearHomeCache`, `ChatSessionCubit` lazy singleton). Aynı yerde `FastingSessionCubit`, su günü
      önbelleği, öneriler, ana ekran widget verileri de temizlenmiyor.
- [ ] Plan detayında yeme penceresi yanlış (16-8 → 12:00–18:00 = 6 sa; sunucu 8 sa ister) ve diyalog değişmese bile `custom`
      gönderiyor → `VALIDATION_FAILED` (`plan_detail_args.dart`, `plan_detail_view_mixin.dart`).
- [ ] OMAD / 23_1 hiç kaydedilemiyor: sunucu `defaultTiming=custom`, istemci pencere göndermiyor; `"OMAD".split('-')` → 6 sa.
- [ ] Onboarding'de 18 yaş altı 16:8/18:6/20:4/OMAD/5:2 seçebiliyor; sunucu `minAge: 18` ile en sonda `UNSAFE_REQUEST` veriyor.
- [ ] Adım ekranında 600 ms içinde gün değiştirilirse bugünün değeri kaybolur / düne yazılır (`steps_view_mixin.dart` `_selectStepsDate`).
- [ ] Ana sayfa iyimser kilo hatada geri alınmıyor (`lastSummaryUnchanged` emit'i engelliyor).

### 8.3 Orta

- [ ] Onboarding: ücretsiz kullanıcı premium plan seçince kilit yok, sonunda plan sessizce `pendingPlanCode`; engeller tek seçim
      ("hepsini seç" diyor); hedef BMI < 17.5 ve öğün penceresi başlangıç = bitiş en sonda reddediliyor; kilo alma/koruma hedefinde
      hedef kilo mevcut kilonun üstüne çıkamıyor; projeksiyon tarihi sunucudan birkaç gün farklı.
- [ ] Dil: uygulamada dil değişince `PATCH /user/me {locale}` yok (push İngilizce gelir); it/ru `supportedLocales`'te yok,
      listedeki pt/ko/hi/ja seçilince hiçbir şey olmuyor.
- [ ] Bildirim izni yalnızca onboarding sonunda; mevcut hesapla girişte hiç istenmiyor (iOS/Android 13+ push gelmez).
- [ ] Silinmek üzere olan misafir hesapla yeniden onboarding → en sonda sabit Türkçe "Hesap silinmek üzere" hatası, çıkış yok.
- [ ] Widget: yeme penceresinde "Eating 00:00 left", plan widget'ları sabit 20:00; uygulama kapalıyken geri sayım donuk; widget'a
      dokununca soğuk açılışta Su yerine Home; onboarding bitmemiş kullanıcıda push/widget korumalı ekran açıyor.
- [ ] Fotoğraf analizi istemci 30 sn'de vazgeçiyor (sunucu 45 sn × 3 deneme) → hak boşa gider; hata/`notFood`'da başlık örnek metin
      "Grilled Chicken…"; kaydet sonrası kamera ekranına dönüyor; hızlı kcal ve AI öğünde "orucu bitir?" sorulmuyor.
- [ ] Profil plan değişimi timing'i sıfırlıyor; profil 15_9 / 19_5 planlarını tanımıyor ("–").
- [ ] Sohbet: hata olunca yazılan metin kayboluyor; akış sürerken ikinci mesaj / başka konuşma açılabiliyor (yanıt yanlış
      konuşmaya akıyor); SSE parça sınırında Türkçe/Rusça harf bozuluyor (`utf8.decode` parça parça).
- [ ] Mochi World yalnızca ilk açılışta yükleniyor (sekme canlı kalıyor, oruç sonrası güncellenmiyor).
- [ ] Su: oz birimi seçilse de her yerde "ml"; gece yarısını geçince açık ekranda + çalışmıyor.
- [ ] Adım: sağlık senkronlu günde +/− 409 alıyor (butonlar gizlenmeli); +/− sonrası kcal/km/dk güncellenmiyor.
- [ ] Uyku: "dün gece" satırı gerçek yatış/kalkış değil program saatlerini gösteriyor; kayıt düzenlenemiyor/silinemiyor (409 tuzağı);
      adım/uyku hedefleri değiştirilemiyor.
- [ ] Açlık: geçmişten "Log my hunger" hep "Fiziksel"; "Full check" geçmiş listesini açıyor (`mode: full` hiç gitmiyor);
      güvenlik bayrağında "orucu bitir" kısayolu yok.
- [ ] Kilo almak isteyen kullanıcıda vücut geçmişi ilerlemesi hep %0 (`body_history_view.dart` işaretsiz `span`).
- [ ] Öğün tarih seçici 2 yıl geri / gelecek saat izin veriyor (sunucu 30 gün); 30 günden eski öğünün notu düzenlenemiyor.
- [ ] Sağlık izni geri alınırsa Android her ön plana dönüşte izin ekranı açıyor.
- [ ] `requiredConsents` (şartlar/gizlilik sürümü değişince yeniden onay) hiç okunmuyor.

### 8.4 Düşük

- [ ] Premium alındıktan sonra ana sayfa "Premium" hapı özet yenilenene kadar duruyor; satın alma sonrası ilk tekrar 402 alabilir.
- [ ] Bildirimler hepsi "Bugün" başlığı altında, "72 saat önce", tüm tipler "meal" ikonu, hata boş durum gibi.
- [ ] Profil "Değerlendir" ve "Paylaş" satırları boş; açlık başarı ekranı "Insights" kartı boş.
- [ ] AI rıza kaydı ağ hatasında sessiz; `CONSENT_REQUIRED` gelince yerel önbellek temizlenmiyor.
- [ ] Kalori ekranı yeme bozukluğu bayrağında "0 kcal over" gösteriyor; kalan kcal hiç yok; "Eated {}".
- [ ] Oruç geçmişinde aktif oruç "— / 16h"; insight premium kilidi okunmuyor; `fastingapp://plans` push'u sekmeye geçmiyor.
- [ ] Aynı kilo tekrar girilince kayıt atılmıyor; vücut geçmişi iyimser nokta yanlış kovaya yazılabiliyor; su 6000 ml uyarısı yok;
      haftalık planlarda widget hafta çubukları yanlış payda; kilo birimi (lb) yok sayılıyor, başlangıç = hedef → %0.
- [ ] Çıkış sırasında hızlı yeniden giriş yarışı; geri alma reddedilince başka oturum token'ı silinebiliyor.
