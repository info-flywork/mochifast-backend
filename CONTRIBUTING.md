# Katkı Rehberi

## Katmanlar

```
route ──► service ──► repository ──► mysql2
            ├──► başka modülün SERVICE'i (asla repository'si değil)
            ├──► infra (cache, queue, bunny, openai…)
            └──► domain olayı yayınla
```

| Katman            | Sorumluluk                                                                       | Yapmaz          |
| ----------------- | -------------------------------------------------------------------------------- | --------------- |
| `*.routes.js`     | Şema, auth kancası, durum kodu, service çağrısı                                  | İş mantığı, SQL |
| `*.service.js`    | İş kuralları, sahiplik kontrolü, transaction sınırı, cache invalidation, olaylar | HTTP ayrıntısı  |
| `*.repository.js` | Yalnızca SQL; satır ↔ domain dönüşümü                                            | İş kararı       |
| `*.rules.js`      | Saf fonksiyonlar (seri, skor, BMI…), %100 birim test                             | Yan etki, I/O   |

## Kurallar

- **SQL:**
  - Yalnızca placeholder kullanılır (`?` / `:ad`). `${…}` interpolasyonu lint tarafından yasaklanır.
  - Dinamik kolon veya sıralama gerekiyorsa whitelist sözlüğünden seçilir.
- **IDOR:**
  - Kullanıcıya ait her sorgu `user_id` ile kapsanır.
  - Başkasının kaydına erişim 404 döner, 403 değil.
- **Şemalar:**
  - Her route `body`/`querystring`/`params` **ve `response`** şemasına sahip olmalı.
  - Girdi şemalarında `additionalProperties: false` kullanılır.
- **Hatalar:**
  - Service katmanı yalnızca `AppError` fırlatır.
  - Yeni hata kodu eklenirse `src/shared/errors.js` dosyasına ve `src/locales/*.json` içindeki 7 dile eklenir.
- **Log:** PII loglanmaz. Bunlar şunları kapsar: token, e-posta, not, sohbet içeriği, sağlık değerleri. Yeni hassas alan eklenirse `REDACT_PATHS` listesine eklenir.
- **Zaman:**
  - DB'ye UTC yazılır.
  - Günlük hesaplar `local_date` + `tz` ile yapılır (`src/shared/time.js`).
- **Kimlik:** Birincil anahtar UUIDv7 kullanılır, DB'de `BINARY(16)` olarak saklanır (`src/shared/ids.js`).
- **Migration:**
  - Yeni dosya `npm run migrate:new -- <ad>` ile oluşturulur.
  - Uygulanmış bir migration **asla düzenlenmez**; değişiklik için yeni migration eklenir.
  - DDL örtük commit yaptığı için dosyalar küçük ve tek amaçlı tutulur.

## Endpoint "Definition of Done"

- [ ] Girdi ve yanıt şemaları tanımlı, `additionalProperties: false`
- [ ] Auth ve sahiplik testi (başkasının kaydına erişim → 404)
- [ ] İş kuralları saf fonksiyonda ve birim testli
- [ ] Entegrasyon testi (gerçek MySQL): mutlu yol, doğrulama hatası, yetki hatası
- [ ] Cache okuma ve invalidation kuralı eklendi
- [ ] Rate limit sınıfı belirlendi
- [ ] Hata kodları katalogda; mesajlar en az `en` ve `tr` dilinde
- [ ] Loglarda PII yok; gerekiyorsa metrik eklendi
- [ ] OpenAPI'de görünüyor
- [ ] Migration gözden geçirildi (indeksler, `EXPLAIN`, geri dönüş planı)

## Commit & PR

- **Commit mesajları:** [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`…). Commitlint, `commit-msg` hook'unda zorunlu kılar.
- **Pre-commit:** lint-staged (ESLint + Prettier).
- **PR öncesi:** `npm run check` yerelde temiz olmalı.
