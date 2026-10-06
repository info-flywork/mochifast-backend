/**
 * `system` kuyruğunun işleri. F0'da yalnızca heartbeat: zamanlayıcı → kuyruk → worker
 * hattının uçtan uca çalıştığını kanıtlar (BullMQ dashboard / loglardan izlenir).
 */
export function systemJobs({ logger }) {
  return {
    async heartbeat(job) {
      const at = new Date().toISOString();
      logger.debug({ jobId: job.id, at }, 'heartbeat');
      return { at };
    },
  };
}
