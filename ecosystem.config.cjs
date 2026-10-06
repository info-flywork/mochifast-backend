/**
 * PM2 süreç tanımları. Sunucuda (uygulama klasöründe):
 *   pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save
 *
 * Ortam değişkenlerini uygulama kendisi `.env`'den okur (src/config/env-file.js).
 * `migrate` burada YOK: sürekli süreç değil, deploy adımıdır (scripts/deploy.sh).
 */
module.exports = {
  apps: [
    {
      name: 'mochifast-api',
      script: 'src/server.js',
      cwd: __dirname,
      // Tek process: cache ve rate limit sayaçları process belleğinde (docs/adr/0005-redis-yok.md).
      // Birden çok kopyaya çıkmak paylaşımlı bir store gerektirir.
      exec_mode: 'fork',
      instances: 1,
      // Kapanışta açık isteklerin bitmesi beklenir (SHUTDOWN_GRACE_MS = 25 sn) + pay.
      kill_timeout: 30_000,
      max_memory_restart: '512M',
      // Loglar pino JSON'u; zaman damgası zaten içinde.
      merge_logs: true,
    },
    {
      name: 'mochifast-worker',
      script: 'src/worker.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      // Kuyruk tüketicisi + tekrarlı iş zamanlayıcısı. Aktif işlerin bitmesi beklenir.
      kill_timeout: 30_000,
      max_memory_restart: '512M',
      merge_logs: true,
    },
  ],
};
