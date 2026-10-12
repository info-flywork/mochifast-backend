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

- [ ] (Kullanıcı şimdilik ertledi) AI rızası kullanıcıya sorulmadan veriliyor: `chat_session_cubit` `_ensureConsent`, `meals_repository.dart` ~53.
- [x] Geçici ağ hatası oturumu kapatıyordu → `expired_token_interceptor.dart`: refresh yalnızca 400/401/403/410 ile reddedilirse oturum biter; ağ/5xx/429'da istek hatayla döner.
- [x] `safetyAcknowledged` gönderilmiyordu (20_4, omad, 5_2 seçilemiyordu) → `lib/domain/fasting/plan_safety.dart` (sabit liste; katalog bağlanınca oradan), `AppDialogs.showPlanSafetyAck` (7 dil `plans.safety_ack_*`), `plan_change_flow.dart` ve Profili Düzenle plan seçimi önce uyarı gösterir, iki repository de alanı gönderir.
- [x] Özet `plan`'ında `timing` yoktu, `applyFromSummary` planı eziyordu → backend `1858ffb`: `/user/summary.plan` artık `/plans/current` ile aynı DTO (`userPlanSchema`).
- [x] Fotoğraf analizine `reasoning_effort` gidiyordu (gpt-4o 400) → `OPENAI_VISION_REASONING_EFFORT` ayrı; `reasoningParam()` yalnızca o-serisi/gpt-5'e gönderir.
- [x] Bütçe kapısı kaldırıldı (`assertBudget`, `ai.daily_budget_usd` seed, `todaysCostMicroUsd`); seed `ai.pricing`'den eski `claude-opus-5-5` silindi.
      Kullanıcıda: canlı DB `app_config.ai.pricing`'e `gpt-4o` fiyatını eklemek (seed mevcut anahtarı güncellemez; `--overwrite-config` tüm config'i ezer, dikkat).
- [ ] (En sona bırakıldı, kullanıcı kararı) Deploy: `deploy.sh` rsync `.env.example`'ı göndermiyor ama dokümanlar sunucuda `cp .env.example .env` diyor.
- [x] Su senkronu hata sonrası hizalanmıyordu (`_waterFlushing` açıkken `loadWaterDay` dönüyordu) → `water_view_mixin.dart` catch'te bayrak önce kapanır.
- [x] Oruçta plan değişince önce oruç iptal ediliyordu → `FastingSessionCubit.changePlanWhileFasting`: önce plan (`_putPlan`, paywall/ret olursa oruç bozulmaz), sonra iptal (+ aynı başlangıçla yeniden başlat), tek `refresh` + tek `afterWrite`.

### 7.2 Sözleşme uyumsuzlukları (kalan)

- [ ] `PUT /steps/:date` tek gün döner; istemci haftalık grafiği siliyor (`steps_view_mixin.dart` ~159). Adım PUT'ları yarışıyor, hatalar yutuluyor.
- [ ] `PATCH /user/onboarding` 404 (`user_repository.dart` ~38 `saveAnsweredQuestions`, `language_level_bloc`).
- [ ] `customGlassSizes` en fazla 5 ve 50–2000 aralığı (`water_reminder_view.dart` ~121); kilo diyaloğu aralığı (profil 30–300, tartı 25–350).
- [ ] Sohbet SSE `safety` olayı atılıyor (`chat_repository.dart` ~262); akış ortasında hata sonrası geçmiş yeniden yüklenmiyor.
- [ ] Su bildirim/birim/bardak ayarları hiç yüklenmiyor (`GET /user/goals` çağrılmıyor).
- [ ] Hatalar boş durum gibi gösteriliyor (öğün kayıtları, uyku, açlık geçmişi); `HomeBloc` yalnızca `Exception` yakalıyor.
- [ ] `fasting_view` çift hata snackbar'ı; paywall sunucu senkronu bitmeden premium=false; açlık belirti eşlemesi yanlış; uyku hafta etiketleri yanlış.
- [ ] Backend küçükler: hesap değiştirmede misafirin push token'ı silinmeli (`auth.service.js` ~251 `clearPushTokens`); üretimde `AI_CHAT_QUOTA_ENABLED=false` koruması ve public Bunny değişkenleri zorunlu değil; dokümanlarda Anthropic kalıntıları (CONTRIBUTING, 09/12); vision istemcisi birim testleri kayboldu; `image_url.detail` yok.

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
- [ ] (Kalan) Ana sayfada iyimser güncelleme yok (kilo girişi özet dönene kadar eski değer). Okunmamış bildirim sayısı yalnızca
      profil ekranında tazelenir.

### 7.4 Loading / performans

- [ ] Splash en az 1,4 sn + özet için 8 sn'ye kadar; 6 sn auth zaman aşımı girişli kullanıcıyı login'e atıyor (`splash_bloc.dart` ~31,51,100) → son özeti diske yaz, hemen geç, arkada tazele; zaman aşımı yedeğini kaldır.
- [ ] `withLoading` gereksiz: paylaş (`fasting_view.dart` ~548, `fasting_first_time_view.dart` ~134), plan değişimi (`plan_change_flow.dart`; PUT dönünce bırak), BuildingPlan (yalnızca 300 ms'den uzun sürerse).
- [ ] Her girişte iskelet/spinner: öğün kayıtları, açlık geçmişi (her filtre; bir kez yükle, istemcide süz), vücut geçmişi (aralıkları önbellekle).
- [ ] Su ekranı her karede tüm sayfayı çiziyor (`water_view.dart` ~101; 5 controller, `ImageFiltered` kabarcıklar) → katman başına `AnimatedBuilder` + `RepaintBoundary`, önceden bulanık görsel.
- [ ] Oruç sekmesi saniyede bir tüm ekranı `setState` (`fasting_view.dart` ~62) → sayaç küçük widget'a.
- [ ] Sonsuz animasyonlar: dalgalar (`home_metric_cards.dart` ~242), sohbet rozeti (`ai_chat_header_icon.dart` ~77). Tüm uygulamada tek `RepaintBoundary`.
- [ ] Widget görselleri uygulama açıkken her dakika 6 PNG (25σ blur) UI isolate'te (`fasting_widget_sync.dart` ~397) → yalnızca durum değişince; geri sayımı native taraf `start_ms/end_ms`'ten yapsın.
- [ ] İlk açılışta 241 görsel (10,5 MB) + SHA-256 UI isolate'te (`app_init.dart` ~25, `remote_image_store.dart` ~179) → `Isolate.run`, home yüklendikten sonra başlat. `app_image.dart` `cacheWidth` yok. `app_init` sıralı await → `Future.wait`.
- [ ] Mochi World: 3 `BackdropFilter` + ~24 görsel precache. Bildirim/açlık listeleri `for` (builder + sayfalama yok). `HomeLoaded` `Equatable` değil.
- [ ] Ağ: güvenli depo her istekte okunuyor (`auth_interceptor.dart` ~15 → bellekte önbellek); `LogInterceptor` gövde + `Authorization` basıyor; refresh sonrası tekrar ayrı `Dio` (`_plain`) ile.

### 7.5 Hâlâ sahte veri

- [ ] Tamamen: Mochi World (`/v1/world`), Insights (`/v1/insights/*`), challenge kartı (`8954` sabit, Katıl boş → `featuredChallenge` + `POST /challenges/:code/join`), metabolik kart (faz 7'ye kadar gizle), SSS (`/catalog/faq`), zorlanma akışı (`/catalog/struggle`, `POST /fasts/:id/struggles`).
- [ ] Kısmen: adımlar (HealthKit/Fit yok, elle giriş kullanılmıyor), uyku kaydı yok, açlık hafta şeridi sabit + değerlendirme hatasında uydurma sonuç + `recommendations`/`safetyFlag` yok sayılıyor, hızlı kcal gönderilmiyor, forecast eğrisi, plan kataloğu (`/catalog/plans`), profil push/sağlık anahtarları (`/user/settings`), kilo kartı sahte 70 kg, sohbet öneri çipleri (`/chat/suggestions`), onboarding pazarlama sayıları (`/app/config.marketing`).
