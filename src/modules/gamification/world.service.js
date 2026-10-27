import * as repo from './gamification.repository.js';
import { nextSceneUserLevel, sceneLevel, worldProgress } from './world.rules.js';

/**
 * GET /v1/world (docs/backend/04-api.md §13). İstemci seviyeyi kendisi hesaplamaz
 * (`round(oran·4)` yerine sunucunun `level` değeri).
 */
export function createWorldService({ db, stats }) {
  return {
    async get(userId) {
      // Gün döndüyse seri ve sağlık önce bugüne göre yenilenir.
      const progress = await stats.progress(userId);
      const [{ zones, health }, week] = await Promise.all([
        repo.readWorld(db, userId),
        stats.week(userId),
      ]);
      const out = zones.map((z) => ({
        zone: z.zone,
        metric: z.metric,
        unit: z.unit,
        current: z.current,
        level: z.level,
        nextThreshold: z.nextThreshold,
        ratioToNext: z.ratioToNext,
        thresholds: z.thresholds,
      }));
      return {
        level: progress.level,
        xp: progress.xp,
        sceneLevel: sceneLevel(progress.level),
        nextSceneLevelAt: nextSceneUserLevel(progress.level),
        health,
        worldProgress: worldProgress(out),
        zones: out,
        week: week.days.map((d) => ({
          date: d.date,
          fastedMinutes: d.fastedMinutes,
          kept: d.kept,
        })),
      };
    },
  };
}
