# MochiFast Backend

MochiFast aralıklı oruç uygulamasının API'si.

|         |                                                                                     |
| ------- | ----------------------------------------------------------------------------------- |
| Runtime | Node.js 24+ (saf JavaScript, ESM `import`/`export` — derleme adımı yok)             |
| HTTP    | Fastify 5 (JSON Schema doğrulama + yanıt serileştirme)                              |
| Veri    | MySQL 8.4 (`mysql2`, ORM yok) · Redis 7 (cache + BullMQ kuyruğu, iki ayrı instance) |
| Gözlem  | pino (PII redaksiyonlu) · Prometheus (`/metrics`, ayrı port) · Sentry               |

Tasarım belgeleri ve yol haritası: `fastingapp` reposunda [`docs/backend/`](../fastingapp/docs/backend/README.md).
Bu repo şu an **F0 (temel altyapı)** aşamasında.

## Hızlı başlangıç

```bash
cp .env.example .env      # DB_* ve REDIS_* değerlerini kendi MySQL 8 / Redis 7 kurulumunuza göre doldurun
npm install
npm run migrate
npm run dev               # http://localhost:3000/health/ready
```

Yerelde Redis için (macOS): `brew install redis && brew services start redis`.

## Süreçler

Hepsi aynı kod tabanından, farklı komutla çalışır (sunucuda PM2 vb. bir süreç yöneticisiyle):

| Komut                     | Görev                                                               | Ömür                           |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| `node src/server.js`      | HTTP API (stateless, N replika)                                     | Sürekli                        |
| `node src/worker.js`      | BullMQ işlerini tüketir (görsel, AI, push, rollup…)                 | Sürekli                        |
| `node src/scheduler.js`   | Tekrarlı işleri Redis'e kaydeder (BullMQ job scheduler), idempotent | **Deploy adımı**, tek seferlik |
| `node scripts/migrate.js` | Bekleyen migration'ları uygular                                     | **Deploy adımı**, tek seferlik |

**Deploy sırası:** `migrate` → `scheduler` → `api` ve `worker` (rolling).

## npm script'leri

| Script                                                | Açıklama                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `dev`, `worker:dev`                                   | `--watch` ile, `.env` okunarak                             |
| `migrate`, `migrate:status`, `migrate:dry`            | Migration'ları uygula / listele / ne uygulanacağını göster |
| `migrate:new -- <ad>`                                 | Sıradaki numarayla boş migration dosyası                   |
| `schedules:sync`                                      | Zamanlamaları Redis ile eşitle                             |
| `test`, `test:unit`, `test:integration`, `test:watch` | Vitest                                                     |
| `lint`, `format`                                      | ESLint · Prettier                                          |
| `check`                                               | Hepsi (CI'ın yerel karşılığı)                              |
| `openapi`                                             | Route şemalarından `openapi.json` üretir                   |

## Testler

```bash
npm test
```

Altyapı gerektiren testler MySQL ve Redis adreslerini ortam değişkenlerinden alır:
`TEST_MYSQL_URL` (ör. `mysql://root:pass@127.0.0.1:3306/`) ve `TEST_REDIS_URL` (ör. `redis://127.0.0.1:6379`).
Verilmezse bu testler **atlanır** (uyarı basılır). `CI=true` ise bu durum hatadır.

Her entegrasyon test dosyası kendi rastgele adlı veritabanını oluşturur ve siler. MySQL kullanıcısının `CREATE DATABASE` yetkisi olmalıdır.

## API sözleşmesi (özet)

- **Ön ek:** `/v1`. Sağlık uçları önek almaz: `/health/live`, `/health/ready`.
- **Başarılı yanıt:** `{ "status": "success", "message": "...", "data": { … } }`. Liste yanıtlarında `data` = `{ items, pageInfo }`.
- **Hata yanıtı:** `{ "status": "error", "message": "<yerelleştirilmiş>", "error": { "code", "details?", "requestId" } }`.
  Kod kataloğu: [`src/shared/errors.js`](src/shared/errors.js). Mesajların 7 dildeki çevirileri: [`src/locales/`](src/locales).
- **Standart header'lar:** `Accept-Language`, `X-Timezone`, `X-App-Version`, `X-Platform`, `X-Install-Id`, `X-Request-Id`.
- **OpenAPI:** Swagger UI `DOCS_ENABLED=true` iken `/docs` adresindedir (basic auth, yalnızca dev/staging).

## Klasör yapısı

```
src/
  server.js · worker.js · scheduler.js · schedules.js · app.js
  config/      env şeması (fail-fast) + sabitler
  infra/       db, redis, cache, queue, migrator, logger, metrics, sentry (iş mantığı yok)
  plugins/     request-context, envelope, errors, security, rate-limit, docs, http-metrics
  shared/      errors, i18n, ids (UUIDv7), time (IANA tz), pagination, schemas
  modules/     domain modülleri: <modül>.routes|schemas|service|repository|rules.js
  jobs/        BullMQ işleyicileri
  locales/     sunucu tarafı mesajlar (en, tr, de, es, fr, it, ru)
migrations/    NNNN_aciklama.sql — yalnızca ileri yönlü, checksum'lı
scripts/       migrate, new-migration, generate-openapi
test/          unit/ · integration/ · helpers/ · setup/
docs/adr/      mimari karar kayıtları
```

Katman kuralları ve kodlama standartları: [CONTRIBUTING.md](CONTRIBUTING.md).
