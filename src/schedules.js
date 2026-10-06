export const SCHEDULES = [
  { id: 'system-heartbeat', queue: 'system', jobName: 'heartbeat', repeat: { every: 60_000 } },
];

/**
 * Tanımları Redis ile eşitler: yenileri/değişenleri upsert eder, listede olmayanları siler.
 */
export async function syncSchedules(queues, schedules = SCHEDULES) {
  let upserted = 0;
  let removed = 0;

  for (const def of schedules) {
    await queues[def.queue].upsertJobScheduler(def.id, def.repeat, { name: def.jobName, data: {} });
    upserted += 1;
  }

  const wanted = new Set(schedules.map((s) => s.id));
  for (const queue of Object.values(queues)) {
    const existing = await queue.getJobSchedulers();
    for (const scheduler of existing) {
      const id = scheduler.key;
      if (id && !wanted.has(id)) {
        await queue.removeJobScheduler(id);
        removed += 1;
      }
    }
  }
  return { upserted, removed };
}
