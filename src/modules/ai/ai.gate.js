import { DateTime } from 'luxon';
import { costMicroUsd } from '../../infra/anthropic.js';
import { AppError } from '../../shared/errors.js';
import { isValidTimezone, localDate } from '../../shared/time.js';
import { userTimezone } from '../stats/stats.repository.js';
import * as repo from './ai.repository.js';

/** Kota türü → `app_config.limits` anahtarları (ücretsiz, premium). */
const LIMIT_KEYS = Object.freeze({
  chat: ['freeChatDaily', 'premiumChatDaily'],
  photo_analysis: ['freePhotoDaily', 'premiumPhotoDaily'],
});
const BUDGET_CACHE_SEC = 60;

/**
 * AI özelliklerinin ortak kapısı (docs/backend/09-yapay-zeka.md §4): rıza, günlük kota (yerel
 * gün), global maliyet sigortası ve kullanım kaydı. Değerler `app_config`'ten okunur (deploy'suz
 * ayarlanır).
 */
export function createAiGate({ db, catalog, cache, logger, entitlements }) {
  const unpriced = new Set();
  async function settings() {
    const config = await catalog.appConfig('all');
    return {
      limits: config.limits ?? {},
      pricing: config['ai.pricing'] ?? {},
      dailyBudgetUsd: config['ai.daily_budget_usd'] ?? null,
    };
  }

  async function zone(userId) {
    const tz = await userTimezone(db, userId);
    const safe = isValidTimezone(tz) ? tz : 'UTC';
    return {
      today: localDate(new Date(), safe),
      resetAt: DateTime.now().setZone(safe).plus({ days: 1 }).startOf('day').toUTC().toISO(),
    };
  }

  const limitOf = (limits, kind, isPremium) => {
    const value = limits[LIMIT_KEYS[kind][isPremium ? 1 : 0]];
    return Number.isInteger(value) ? value : 0;
  };

  const gate = {
    /** Premium mı (abonelik yansıması); worker'da entitlement yoksa ücretsiz sayılır. */
    async isPremium(userId) {
      return entitlements ? entitlements.isPremium(userId) : false;
    },

    /** `ai_processing` rızası yoksa 403 (fotoğraf/metin Anthropic'e gönderilmez). */
    async assertConsent(userId) {
      if (!(await repo.aiConsentGranted(db, userId))) {
        throw new AppError('CONSENT_REQUIRED', { details: { consent: 'aiProcessing' } });
      }
    },

    /**
     * Günlük maliyet sınırı aşıldıysa ücretsiz kullanıcılara AI geçici kapanır (503).
     * Toplam 60 sn önbelleklenir: her istekte tüm kullanıcıların toplamı okunmaz.
     */
    async assertBudget(isPremium) {
      if (isPremium) return;
      const { dailyBudgetUsd } = await settings();
      if (!dailyBudgetUsd) return;
      const spent = await cache.getOrSet('ai:cost:today', BUDGET_CACHE_SEC, () =>
        repo.todaysCostMicroUsd(db),
      );
      if (spent >= dailyBudgetUsd * 1e6) {
        throw new AppError('UNAVAILABLE', { details: { reason: 'ai_budget' } });
      }
    },

    /**
     * Kotadan bir hak düşer; limit aşıldıysa geri alınır ve 429. Dönen `localDate` iade için
     * saklanmalıdır (gün dönse bile aynı güne iade edilir).
     */
    async consume(userId, kind, { isPremium = false } = {}) {
      const { limits } = await settings();
      const limit = limitOf(limits, kind, isPremium);
      const { today, resetAt } = await zone(userId);
      const used = await repo.incrementQuota(db, userId, today, kind);
      if (used > limit) {
        await repo.decrementQuota(db, userId, today, kind);
        throw new AppError('QUOTA_EXCEEDED', {
          details: {
            kind: toApi(kind),
            limit,
            used: used - 1,
            resetAt,
            upgradeAvailable: !isPremium,
          },
        });
      }
      return { localDate: today, used, limit, resetAt };
    },

    /** Başarısız istekte hak iade edilir (5xx, zaman aşımı, ret). */
    async refund(userId, kind, day) {
      await repo.decrementQuota(db, userId, day, kind);
    },

    /** GET /v1/chat/quota ve /v1/ai/quota. */
    async status(userId, options = {}) {
      const isPremium = options.isPremium ?? (await gate.isPremium(userId));
      const [{ limits }, { today, resetAt }] = await Promise.all([settings(), zone(userId)]);
      const used = await repo.quotaUsage(db, userId, today);
      const entry = (kind) => {
        const limit = limitOf(limits, kind, isPremium);
        return {
          used: used[kind] ?? 0,
          limit,
          remaining: Math.max(0, limit - (used[kind] ?? 0)),
          resetAt,
        };
      };
      return { chat: entry('chat'), photoAnalysis: entry('photo_analysis'), isPremium };
    },

    /** Token kullanımı ve maliyet (gerçekte çalışan modelin fiyatıyla; yedek model farklı olabilir). */
    async recordUsage(userId, feature, message) {
      const { pricing } = await settings();
      const usage = message?.usage ?? {};
      const price = pricing[message?.model];
      // Fiyatı tanımsız model (ör. yedek model, yeni sohbet modeli): maliyet 0 sayılır, bir kez uyarılır.
      if (!price && message?.model && !unpriced.has(message.model)) {
        unpriced.add(message.model);
        logger?.warn(
          { model: message.model },
          'app_config ai.pricing içinde bu modelin fiyatı yok',
        );
      }
      const cost = costMicroUsd(usage, price);
      await repo.recordUsage(db, userId, feature, { ...usage, costMicroUsd: cost });
      return cost;
    },
  };
  return gate;
}

const toApi = (kind) => (kind === 'photo_analysis' ? 'photoAnalysis' : kind);
