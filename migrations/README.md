# Migrations

- Ad biçimi: `NNNN_aciklama.sql` (4 hane, küçük harf/rakam/alt çizgi). Oluşturmak için: `npm run migrate:new -- <aciklama>`.
- Yalnızca ileri yönlü. Uygulanmış bir dosya **düzenlenmez**; runner checksum uyuşmazlığında durur.
- Tablo tanımlarının kaynağı: `fastingapp/docs/backend/03-veri-modeli.md` (F1'den itibaren domain bazında eklenir).
