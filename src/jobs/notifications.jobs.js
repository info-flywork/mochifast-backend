import { createPushClient } from '../infra/fcm.js';
import { createJobQueue } from '../infra/queue.js';
import { createNotificationsService } from '../modules/notifications/notifications.service.js';
import { notificationHousekeeping, planDailyReminders } from '../modules/notifications/planner.js';

/**
 * `notifications` kuyruğu (docs/backend/10-bildirimler.md §3). Bağımlılıklar testte enjekte edilir.
 */
export function notificationJobs({ db, config, logger, push }) {
  const service = createNotificationsService({
    db,
    push: push ?? createPushClient(config.push, { logger }),
    jobs: createJobQueue(db),
    logger,
  });
  return {
    /** 30 sn'de bir: vadesi gelenler → gönderim işleri. */
    async notificationDispatch() {
      const n = await service.dispatch();
      if (n > 0) logger.debug({ dispatched: n }, 'bildirimler dağıtıldı');
    },

    async pushSend(job) {
      await service.send(job.payload.id, { attempt: job.attempt, maxAttempts: job.maxAttempts });
    },

    /** Saatlik: yerel gece yarısını geçen dilimlerde günün hatırlatıcıları. */
    async notificationPlanner() {
      const users = await planDailyReminders(db);
      if (users > 0) logger.info({ users }, 'günlük hatırlatıcılar planlandı');
    },

    async notificationHousekeeping() {
      logger.info(await notificationHousekeeping(db), 'bildirim bakımı');
    },
  };
}
