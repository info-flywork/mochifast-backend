import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // MySQL adresi TEST_MYSQL_URL'den gelir; yoksa entegrasyon testleri atlanır (CI'da atlanmaz).
    globalSetup: ['test/setup/global-setup.js'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
    // Entegrasyon testleri aynı veritabanını paylaşır; dosya bazında sıralı çalıştır.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js', 'scripts/**/*.js'],
    },
  },
});
