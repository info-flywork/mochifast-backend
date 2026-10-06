# ADR 0003 — Kimlikler: UUIDv7, BINARY(16)

**Durum:** Kabul edildi · **Tarih:** 2026-10-06

## Karar

Kullanıcı verisi tablolarında birincil anahtar UUIDv7'dir. DB'de `BINARY(16)`, API'de standart string olarak tutulur. Katalog tablolarında `SMALLINT AUTO_INCREMENT` + kararlı `code` kullanılır.

## Gerekçe

- UUIDv7 zaman sıralı olduğu için InnoDB B-tree'de sıralı ekleme yapılır; v4'ün rastgele sayfa bölünmeleri yaşanmaz.
- İstemci ID üretebilir. Çevrimdışı kuyruk ve yeniden denemeler doğal olarak idempotent olur (`isAcceptableClientId`: v7 + ±7 gün).
- `BINARY(16)`, `CHAR(36)`'ya göre indekslerde 2 kattan fazla yer kazandırır.
