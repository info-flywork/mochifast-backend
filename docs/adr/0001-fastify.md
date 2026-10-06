# ADR 0001 — HTTP framework: Fastify 5

**Durum:** Kabul edildi · **Tarih:** 2026-10-06

## Bağlam

Saf JavaScript ile, güvenlik ve performansı yüksek, şema odaklı bir API gerekiyor.

## Karar

Fastify 5 kullanılır. Her route girdi **ve yanıt** JSON Schema'sı tanımlar.

## Gerekçe

- Girdi doğrulama (ajv) ve yanıt serileştirme (fast-json-stringify) çerçevenin yerleşik özelliği. Yanıt şeması yalnızca tanımlı alanları yazdığı için yanlışlıkla alan sızdırmak yapısal olarak engelleniyor.
- Aynı şemalardan OpenAPI üretiliyor (tek kaynak).
- pino logger yerleşik. Plugin kapsülleme modüler monolite uygun. `inject()` ile ağsız ve hızlı HTTP testleri yazılabiliyor.

## Sonuçlar

Express ekosistemi middleware'leri doğrudan kullanılamaz; ihtiyaç duyulanların `@fastify/*` karşılıkları kullanılır.
