# ADR 0004 — İki ayrı Redis: cache ve kuyruk

**Durum:** Yerini aldı → [ADR 0005](0005-redis-yok.md) · **Tarih:** 2026-10-06

## Karar

- `redis-cache` (`allkeys-lru`): cache, rate limit, kilitler. Erişilemezse cache **fail-open** çalışır, rate limit isteği geçirir.
- `redis-queue` (`noeviction` + AOF): BullMQ.

## Gerekçe

BullMQ anahtarları LRU ile silinirse işler kaybolur. Tek instance `noeviction` ile çalışırsa cache dolunca yazmalar hata verir. İki ayrı ihtiyaç iki ayrı politika gerektiriyor.

## Ek karar

Tekrarlı işler BullMQ _job scheduler_ olarak Redis'te tutulur. Sürekli çalışan bir zamanlayıcı process'i yoktur; `scheduler.js` deploy adımında tanımları eşitler.
