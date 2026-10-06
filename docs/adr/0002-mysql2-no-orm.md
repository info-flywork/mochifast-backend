# ADR 0002 — Veri erişimi: mysql2 + repository katmanı, ORM yok, kendi migration aracımız

**Durum:** Kabul edildi · **Tarih:** 2026-10-06

## Karar

- `mysql2/promise` havuzu ve yalnızca `execute` (sunucu tarafı prepared statement) kullanılır. SQL repository dosyalarında açıkça yazılır.
- Migration'lar sıralı `.sql` dosyalarıdır. `src/infra/migrator.js`: checksum, `GET_LOCK`, sıra dışı dosya tespiti.

## Gerekçe

- Ekip tercihi `mysql2`.
- Sorgular görünür ve `EXPLAIN` edilebilir. ORM'in ürettiği N+1 sorguları ve gizli sorgular olmaz.
- Migration aracı ~150 satır, tamamen test edilmiş. Ek bağımlılık gerektirmiyor.

## Sonuçlar

- Satır ↔ nesne dönüşümleri elle yazılır (`BINARY(16)` ↔ UUID, `TINYINT(1)` ↔ boolean `typeCast` ile otomatik).
- Büyük tablo DDL'leri için ileride `gh-ost` veya `pt-osc` değerlendirilir.
