import { memoizeByDeps } from '../../shared/legacy.js';
import { createStatsService } from './stats.service.js';

/** Seri, sayaç ve XP servisi; uçları `fasts` ve `user` modüllerinde. */
export const statsServiceFor = memoizeByDeps((app) => createStatsService({ db: app.deps.db }));
