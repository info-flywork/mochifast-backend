# MochiFast Backend

MochiFast aralıklı oruç uygulamasının API'si.

|         |                                                                                 |
| ------- | ------------------------------------------------------------------------------- |
| Runtime | Node.js 24+ (saf JavaScript, ESM `import`/`export` — derleme adımı yok)         |
| HTTP    | Fastify 5 (JSON Schema doğrulama + yanıt serileştirme)                          |
| Veri    | MySQL 8 (`mysql2`, ORM yok). İş kuyruğu da MySQL'de. **Redis yok** ([ADR 0005]) |
| Sunucu  | VPS · Nginx (TLS, certbot) · PM2                                                |
| Gözlem  | pino (PII redaksiyonlu) · Prometheus (`/metrics`, ayrı port) · Sentry           |

[ADR 0005]: docs/adr/0005-redis-yok.md

Tasarım belgeleri ve yol haritası: `fastingapp` reposunda [`docs/backend/`](../fastingapp/docs/backend/README.md).
Bu repo şu an **F0 (temel altyapı)** aşamasında.

## Hızlı başlangıç

```bash
cp .env.example .env      # DB_* değerlerini kendi MySQL 8 kurulumuna göre doldur
npm install
npm run migrate
npm run dev               # http://localhost:3000/health/ready
npm run worker:dev        # ayrı terminalde: kuyruk + tekrarlı işler
```

## Süreçler

| Komut                     | Görev                                                             | Ömür                           |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------ |
| `node src/server.js`      | HTTP API (tek process; cache ve rate limit bellekte)              | Sürekli (PM2)                  |
| `node src/worker.js`      | `jobs` tablosundaki işleri tüketir + tekrarlı işleri kuyruğa atar | Sürekli (PM2)                  |
| `node scripts/migrate.js` | Bekleyen migration'ları uygular                                   | **Deploy adımı**, tek seferlik |

Hepsi `.env`'i kendisi okur (`src/config/env-file.js`); komut satırından verilen değişken önceliklidir.

## Yayına alma

Adım adım rehber: [docs/deploy.md](docs/deploy.md). Kısaca:

```bash
npm run deploy              # kodu gönder → npm ci → migrate → pm2 reload → /health/ready
```

## npm script'leri

| Script                                                 | Açıklama                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `dev`, `worker:dev`                                    | `--watch` ile                                              |
| `start`, `worker`                                      | Üretim komutları (PM2 `ecosystem.config.cjs` kullanır)     |
| `migrate`, `migrate:status`, `migrate:dry`             | Migration'ları uygula / listele / ne uygulanacağını göster |
| `migrate:new -- <ad>`                                  | Sıradaki numarayla boş migration dosyası                   |
| `deploy [-- sync [--env] \| release \| check \| logs]` | Sunucuya yayına alma ([docs/deploy.md](docs/deploy.md))    |
| `test`, `test:unit`, `test:integration`, `test:watch`  | Vitest                                                     |
| `lint`, `format`                                       | ESLint · Prettier                                          |
| `check`                                                | Hepsi (CI'ın yerel karşılığı)                              |
| `openapi`                                              | Route şemalarından `openapi.json` üretir                   |

## Testler

```bash
TEST_MYSQL_URL='mysql://root:sifre@127.0.0.1:3306/' npm test
```

`TEST_MYSQL_URL` verilmezse MySQL isteyen testler **atlanır** (uyarı basılır). `CI=true` ise bu durum hatadır.
Her entegrasyon test dosyası kendi rastgele adlı veritabanını oluşturur ve siler. Bu yüzden MySQL kullanıcısının `CREATE DATABASE` yetkisi olmalı.

## İş kuyruğu (özet)

```js
// API içinde: iş kaydıyla aynı transaction'da kuyruğa at (ikisi birlikte yazılır ya da hiçbiri)
await db.withTransaction(async (conn) => {
  await repo.saveFast(conn, fast);
  await app.deps.jobs.enqueue(
    'push',
    'fastCompleted',
    { userId },
    { conn, dedupeKey: `fast:${fast.id}` },
  );
});
```

İşleyiciler `src/jobs/*.jobs.js` içinde, kuyruklar `src/worker.js` içinde, tekrarlı işler `src/schedules.js` içinde tanımlanır.
İşleyiciler **idempotent** yazılmalı, çünkü bir iş en az bir kez çalışır. Kuyruğun durumunu görmek için:
`SELECT queue, status, COUNT(*) FROM jobs GROUP BY queue, status;`

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
  server.js · worker.js · schedules.js · app.js
  config/      env şeması (fail-fast) + sabitler
  infra/       db, cache, queue (MySQL), migrator, logger, metrics, sentry (iş mantığı yok)
  plugins/     request-context, envelope, errors, security, rate-limit, docs, http-metrics
  shared/      errors, i18n, ids (UUIDv7), time (IANA tz), pagination, schemas
  modules/     domain modülleri: <modül>.routes|schemas|service|repository|rules.js
  jobs/        kuyruk işleyicileri
  locales/     sunucu tarafı mesajlar (en, tr, de, es, fr, it, ru)
migrations/    NNNN_aciklama.sql — yalnızca ileri yönlü, checksum'lı
scripts/       migrate, new-migration, generate-openapi, deploy.sh
deploy/        nginx ayarı, sunucu kontrolü, deploy.env örneği
test/          unit/ · integration/ · helpers/ · setup/
docs/adr/      mimari karar kayıtları
```

Katman kuralları ve kodlama standartları: [CONTRIBUTING.md](CONTRIBUTING.md).
