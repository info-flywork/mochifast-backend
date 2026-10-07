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
];
