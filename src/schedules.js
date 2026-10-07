/**
 * Tekrarlı işlerin tanımları. Worker açılışta `job_schedules` tablosunu bunlarla eşitler:
 * yenileri ekler, aralığı değişeni günceller, listeden çıkarılanı siler.
 */
export const SCHEDULES = [
  { id: 'system-heartbeat', queue: 'system', jobName: 'heartbeat', everyMs: 60_000 },
  { id: 'system-jobs-cleanup', queue: 'system', jobName: 'jobsCleanup', everyMs: 3_600_000 },
  {
    id: 'system-idempotency-cleanup',
    queue: 'system',
    jobName: 'idempotencyCleanup',
    everyMs: 3_600_000,
  },
  // 05 §1.3: 72 saati geçen aktif oruçlar.
  { id: 'stats-fast-autoclose', queue: 'stats', jobName: 'fastAutoclose', everyMs: 15 * 60_000 },
  // Yerel gece yarısını geçen saat dilimlerinde seri tazeleme (yarım saatlik dilimler de yakalanır).
  { id: 'stats-day-rollover', queue: 'stats', jobName: 'dayRollover', everyMs: 3_600_000 },
  // 05 §14: son 26 saatte değişen kullanıcılar için tam yeniden hesaplama.
  { id: 'stats-daily-rollup', queue: 'stats', jobName: 'dailyRollup', everyMs: 86_400_000 },
  // 08 §6: medya yaşam döngüsü.
  { id: 'media-stuck', queue: 'media', jobName: 'mediaStuck', everyMs: 15 * 60_000 },
  { id: 'media-unattached', queue: 'media', jobName: 'mediaUnattached', everyMs: 3_600_000 },
  { id: 'media-deleted-meals', queue: 'media', jobName: 'mediaDeletedMeals', everyMs: 21_600_000 },
];
