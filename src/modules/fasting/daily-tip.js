import { createHash } from 'node:crypto';
import { DEFAULT_LOCALE } from '../../config/constants.js';
import { toBin } from '../../shared/ids.js';
import { isValidTimezone, localDate } from '../../shared/time.js';

/**
 * Günün ipucu (`GET /v1/fasts/daily-tip`): AI yok. Katalogdaki `daily_tip` etiketlerinden, oruç
 * sürüyorsa `fast_*`, yoksa `eat_*` grubundan kullanıcı + yerel gün için deterministik seçim
 * (gün içinde aynı ipucu, günler ve kullanıcılar arasında dağılır).
 */
export function pickTip(codes, userId, day) {
  if (codes.length === 0) return null;
  const hash = createHash('sha256').update(`${userId}:${day}`).digest();
  return [...codes].sort()[hash.readUInt32BE(0) % codes.length];
}

export function createDailyTipService({ db }) {
  return {
    async dailyTip(userId, locale, now = new Date()) {
      const id = toBin(userId);
      const [user, active, rows] = await Promise.all([
        db.one('SELECT timezone, locale FROM users WHERE id = :id', { id }),
        db.one(
          `SELECT 1 AS active FROM fasting_sessions
            WHERE user_id = :id AND status = 'active' AND deleted_at IS NULL`,
          { id },
        ),
        db.many(
          `SELECT code, locale, label FROM catalog_labels
            WHERE namespace = 'daily_tip' AND locale IN (:locale, :fallback)`,
          { locale: locale ?? user?.locale ?? DEFAULT_LOCALE, fallback: DEFAULT_LOCALE },
        ),
      ]);
      const phase = active ? 'fast' : 'eat';
      const wanted = locale ?? user?.locale ?? DEFAULT_LOCALE;
      const texts = new Map();
      for (const r of rows) {
        if (!r.code.startsWith(`${phase}_`)) continue;
        if (r.locale === wanted || !texts.has(r.code)) texts.set(r.code, r.label);
      }
      const day = localDate(now, isValidTimezone(user?.timezone) ? user.timezone : 'UTC');
      const code = pickTip([...texts.keys()], userId, day);
      return { tip: code ? { code, phase, date: day, text: texts.get(code) } : null };
    },
  };
}
