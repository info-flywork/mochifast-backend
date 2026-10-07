# Yük testi (k6)

Sabah zirvesi senaryosu ve SLO eşikleri: `docs/backend/07-cache-performans.md` §8.1, §9.

1. **Yalnızca staging** (üretim verisine yazar: kullanıcı, su, öğün). Staging API'de geçici olarak
   `RATE_LIMIT_GLOBAL_MAX=1000000` (yük tek IP'den gelir) ve sohbet/AI anahtarları boş olabilir.
2. Kullanıcılar: `JWT_ACCESS_TTL_SEC=3600 node loadtest/create-users.js 500` (staging `.env` ile).
   Token'lar 1 saat geçerli.
3. Çalıştır (k6: `brew install k6`):
   ```bash
   BASE_URL=https://staging-api.example.com k6 run loadtest/morning-peak.js
   ```
   Kısa deneme: `RATE=50 DURATION=1m`.
4. Sonuç: eşikler (`thresholds`) kırmızıysa darboğaz analizi: `/metrics` →
   `mochifast_db_pool_*` (havuz doygunluğu), `mochifast_cache_requests_total` (isabet oranı),
   yavaş sorgu logu (`DB_SLOW_QUERY_MS`), `EXPLAIN` ile indeks kontrolü.
5. Temizlik: test kullanıcılarını sil (misafir saklama işi 90 gün sonra zaten siler).

Not: Uzak cPanel MariaDB ile VPS arasındaki gecikme (geliştirmede sorgu başına ~50 ms) SLO'ları
tek başına aşabilir; yük testi API ile aynı ağdaki DB'de anlamlıdır.
