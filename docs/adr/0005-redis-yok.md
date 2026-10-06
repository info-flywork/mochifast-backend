# ADR 0005 — Redis yok: MySQL iş kuyruğu + process içi cache

**Durum:** Kabul edildi · **Tarih:** 2026-10-06 · [ADR 0004](0004-two-redis-instances.md)'ün yerini alır

## Bağlam

Sunucu tek bir VPS (Nginx + PM2 + MySQL). Ek bir servis (Redis) kurmak, izlemek ve yedeklemek
istenmiyor. Mevcut trafik tek API process'iyle rahatça karşılanıyor.

## Karar

- **İş kuyruğu:** `jobs` tablosu (`migrations/0001_create_jobs.sql`, `src/infra/queue.js`).
  Worker `SELECT … FOR UPDATE SKIP LOCKED` ile iş kapar. Hatalı iş üstel geri çekilmeyle tekrar
  denenir. Çöken worker'ın işi kilit süresi dolunca kuyruğa döner. `dedupeKey` aynı işin iki kez
  atılmasını engeller.
- **Tekrarlı işler:** `job_schedules` tablosu. Tanımlar `src/schedules.js` dosyasında. Worker
  açılışta tabloyu bu tanımlarla eşitler ve her saniye vadesi gelenleri kuyruğa atar. Ayrı bir
  scheduler süreci ya da deploy adımı yok.
- **Cache:** process içi LRU (`src/infra/cache.js`), TTL jitter ve single-flight ile.
- **Rate limit:** `@fastify/rate-limit` bellek içi store.
- **API tek process** çalışır (PM2 fork). Böylece cache invalidation ve rate limit sayaçları
  tutarlı kalır.

## Sonuçlar

- (+) Kurulacak ek servis yok. İşler iş verisiyle **aynı transaction'da** kuyruğa atılabilir
  (`enqueue(..., { conn })`). Kayıt yazılıp işin kaybolması gibi bir durum olmaz.
- (+) Kuyruk MySQL yedeklerine dahil. İşler SQL ile izlenebilir:
  `SELECT status, COUNT(*) FROM jobs GROUP BY status`.
- (−) Boş kuyrukta worker saniyede bir sorgu atar. İş gecikmesi en fazla `WORKER_POLL_MS`.
- (−) API yeniden başlarken (deploy) cache boşalır ve rate limit sayaçları sıfırlanır. PM2 fork
  modunda reload sırasında 1–2 sn kesinti olur.
- (−) Yatay ölçek (birden çok API kopyası ya da sunucu) gerekirse cache ve rate limit için
  paylaşımlı bir store (Redis) yeniden değerlendirilir. Kuyruk birden çok worker'la zaten
  çalışır.
