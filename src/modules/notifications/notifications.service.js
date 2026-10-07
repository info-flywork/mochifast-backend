import { DateTime } from 'luxon';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../../config/constants.js';
import { AppError } from '../../shared/errors.js';
import { toBin } from '../../shared/ids.js';
import { decodeCursor, encodeCursor } from '../../shared/pagination.js';
import { isValidTimezone, localDate } from '../../shared/time.js';
import * as repo from './notifications.repository.js';
import {
  CATEGORY_PUSH_LIMIT,
  CATEGORY_SETTING,
  DAILY_PUSH_LIMIT,
  NEW_USER_DAYS,
  quietUntil,
  render,
} from './notifications.rules.js';

/** Dispatcher partisi (10 §3). */
export const DISPATCH_BATCH = 500;

/**
 * Bildirim gönderimi ve gelen kutusu (docs/backend/10-bildirimler.md).
 * Planlama `notify.js` ile alan servislerinde; burada: gönderim kararı (ayar, rıza, sessiz saat,
 * sınır, hâlâ geçerli mi), render, inbox, push.
 */
export function createNotificationsService({ db, push, jobs, logger }) {
  const localeOf = (l) => (SUPPORTED_LOCALES.includes(l) ? l : DEFAULT_LOCALE);

  /** Yer tutucu değerleri dile göre: bölge adı, challenge başlığı, plan adı. */
  async function localizedParams(params, locale) {
    const out = { ...params };
    if (params.zone) {
      const row = await db.one(
        `SELECT label FROM catalog_labels WHERE namespace = 'world_zone' AND code = :code
          AND locale IN (:locale, :fallback) ORDER BY locale = :locale DESC LIMIT 1`,
        { code: params.zone, locale, fallback: DEFAULT_LOCALE },
      );
      out.zone = row?.label ?? params.zone;
    }
    if (params.challenge) {
      const row = await db.one(
        `SELECT t.title FROM challenges c JOIN challenge_translations t ON t.challenge_id = c.id
          WHERE c.code = :code AND t.locale IN (:locale, :fallback)
          ORDER BY t.locale = :locale DESC LIMIT 1`,
        { code: params.challenge, locale, fallback: DEFAULT_LOCALE },
      );
      out.challenge = row?.title ?? params.challenge;
    }
    for (const key of ['planName', 'toPlan']) {
      const code = key === 'planName' ? params.planCode : params.toPlan;
      if (!code) continue;
      const row = await db.one(
        `SELECT t.display_name FROM fasting_plans p
           JOIN fasting_plan_translations t ON t.plan_id = p.id
          WHERE p.code = :code AND t.locale IN (:locale, :fallback)
          ORDER BY t.locale = :locale DESC LIMIT 1`,
        { code, locale, fallback: DEFAULT_LOCALE },
      );
      out.planName = row?.display_name ?? code.replace('_', ':');
    }
    return out;
  }

  async function renderFor(template, params, locale) {
    const text = repo.textFor(template, locale);
    const values = await localizedParams(params ?? {}, locale);
    return { title: render(text.title, values, locale), body: render(text.body, values, locale) };
  }

  /**
   * Bildirim gönderim anında hâlâ anlamlı mı? (Durum o andan beri değişmiş olabilir.)
   * @returns null (geçerli) ya da atlanma sebebi
   */
  async function stillRelevant(n, tz) {
    const u = toBin(n.userId);
    const one = (sql, params = {}) => db.one(sql, { u, ...params });
    switch (n.type) {
      case 'fast_goal_reached':
      case 'fast_halfway':
      case 'fast_stage_reached':
      case 'fast_overdue': {
        const s = await one(
          'SELECT status FROM fasting_sessions WHERE id = :id AND user_id = :u AND deleted_at IS NULL',
          { id: toBin(n.params.fastId) },
        );
        return s?.status === 'active' ? null : 'fast_not_active';
      }
      case 'fast_start_reminder':
      case 'eating_window_ending': {
        const active = await one(
          "SELECT id FROM fasting_sessions WHERE user_id = :u AND status = 'active' AND deleted_at IS NULL",
        );
        return active ? 'fast_active' : null;
      }
      case 'water_reminder': {
        const today = localDate(new Date(), tz);
        const day = await one(
          `SELECT ds.water_ml, g.water_goal_ml,
                  (SELECT MAX(logged_at) FROM water_entries
                    WHERE user_id = :u AND deleted_at IS NULL) AS last_at
             FROM user_goals g
             LEFT JOIN daily_summaries ds ON ds.user_id = g.user_id AND ds.local_date = :today
            WHERE g.user_id = :u`,
          { today },
        );
        if (day && (day.water_ml ?? 0) >= day.water_goal_ml) return 'water_goal_reached';
        if (day?.last_at && Date.now() - day.last_at.getTime() < 60 * 60_000) return 'water_recent';
        return null;
      }
      case 'weight_reminder': {
        const w = await one(
          `SELECT MAX(recorded_at) AS at FROM weight_entries WHERE user_id = :u AND deleted_at IS NULL`,
        );
        return w?.at && Date.now() - w.at.getTime() < 7 * 86_400_000 ? 'weight_recent' : null;
      }
      case 'streak_nudge': {
        const today = localDate(new Date(), tz);
        const row = await one(
          `SELECT s.current_streak,
                  (SELECT fasted_minutes FROM daily_summaries
                    WHERE user_id = :u AND local_date = :today) AS fasted,
                  (SELECT id FROM fasting_sessions
                    WHERE user_id = :u AND status = 'active' AND deleted_at IS NULL) AS active
             FROM user_stats s WHERE s.user_id = :u`,
          { today },
        );
        if (!row || row.current_streak < 2) return 'no_streak';
        if (row.active || (row.fasted ?? 0) > 0) return 'already_fasting';
        return null;
      }
      default:
        return null;
    }
  }

  const service = {
    /** Dispatcher (30 sn): vadesi gelenleri `processing` yapıp gönderim işlerine dağıtır. */
    async dispatch() {
      const due = await repo.claimDue(db, DISPATCH_BATCH);
      for (const n of due) {
        await jobs.enqueue(
          'notifications',
          'pushSend',
          { id: n.id },
          { maxAttempts: 3, dedupeKey: `push:${n.id}:${n.attempts}` },
        );
      }
      return due.length;
    },

    /**
     * Tek bildirim: ayar/rıza/sessiz saat/sınır kontrolü → inbox → push. Geçici FCM hatasında
     * son deneme değilse hata fırlatır (kuyruk yeniden dener).
     */
    async send(id, { attempt = 1, maxAttempts = 1 } = {}) {
      const n = await repo.findScheduled(db, id);
      if (!n || n.status !== 'processing') return 'noop';
      const finish = (status, extra = {}) => repo.finish(db, id, { status, ...extra });

      const template = (await repo.templates(db))[n.type];
      if (!template) return finish('skipped', { error: 'unknown_type' }).then(() => 'skipped');
      const user = await repo.recipient(db, n.userId);
      if (!user) return finish('skipped', { error: 'no_user' }).then(() => 'skipped');
      const tz = isValidTimezone(user.timezone) ? user.timezone : 'UTC';
      const locale = localeOf(user.locale);
      const category = template.category;

      const irrelevant = await stillRelevant(n, tz);
      if (irrelevant)
        return finish('skipped', { error: irrelevant, category }).then(() => 'skipped');

      // Push kararı (inbox her durumda yazılır).
      let pushReason = null;
      let silent = false;
      const wantsPush = template.channel.includes('push');
      if (wantsPush) {
        const setting = CATEGORY_SETTING[category];
        // Ayar satırı yoksa (onboarding öncesi) varsayılanlar: push açık, su ve pazarlama kapalı.
        const categoryOn = setting
          ? (user[setting] ?? !['notif_water', 'notif_marketing'].includes(setting))
          : true;
        if (user.push_enabled === false) pushReason = 'push_disabled';
        else if (!categoryOn) pushReason = 'category_off';
        else if (category === 'marketing') pushReason = 'marketing_requires_consent';
      }
      if (wantsPush && !pushReason) {
        const quietEnd = quietUntil(
          new Date(),
          tz,
          user.quiet_start ?? '22:30',
          user.quiet_end ?? '08:00',
        );
        if (quietEnd) {
          if (template.quietHours === 'defer') {
            const delayMin = (quietEnd.getTime() - n.fireAt.getTime()) / 60_000;
            if (template.maxDelayMin !== null && delayMin > template.maxDelayMin) {
              if (!template.channel.includes('inbox')) {
                return finish('skipped', { error: 'quiet_hours', category }).then(() => 'skipped');
              }
              pushReason = 'quiet_hours';
            } else {
              await repo.defer(db, id, quietEnd, 'quiet_hours_deferred');
              return 'deferred';
            }
          } else if (template.quietHours === 'silent') {
            silent = true;
          }
        }
      }
      if (wantsPush && !pushReason) {
        const ageDays = (Date.now() - user.created_at.getTime()) / 86_400_000;
        if (ageDays < NEW_USER_DAYS && category !== 'fasting' && category !== 'system') {
          pushReason = 'new_user_quiet_period';
        }
      }
      if (wantsPush && !pushReason) {
        const startOfDay = DateTime.now().setZone(tz).startOf('day').toJSDate();
        const sent = await repo.pushedSince(db, n.userId, startOfDay);
        if (sent.total >= DAILY_PUSH_LIMIT) pushReason = 'daily_limit';
        else if ((sent.byCategory[category] ?? 0) >= CATEGORY_PUSH_LIMIT)
          pushReason = 'category_limit';
      }

      let pushed = false;
      if (wantsPush && !pushReason) {
        const devices = await repo.pushDevices(db, n.userId);
        if (devices.length === 0) pushReason = 'no_device';
        else if (!push.enabled) pushReason = 'push_not_configured';
        else {
          const { title, body } = await renderFor(template, n.params, locale);
          const results = await push.sendEach(
            devices.map((d) => d.token),
            {
              title,
              body,
              silent,
              data: { type: n.type, deepLink: template.deepLink, notificationId: id },
            },
          );
          let transient = false;
          for (const [i, r] of results.entries()) {
            const device = devices[i];
            if (r.status === 'invalid_token') await repo.clearToken(db, device.id);
            if (r.transient) transient = true;
            await repo.recordDelivery(db, n.userId, {
              deviceId: device.id,
              type: n.type,
              status: r.status,
              messageId: r.messageId,
              errorCode: r.errorCode,
            });
          }
          pushed = results.some((r) => r.status === 'sent');
          if (!pushed && transient && attempt < maxAttempts) {
            throw new Error('FCM geçici hata; yeniden denenecek');
          }
          if (!pushed)
            pushReason = results.every((r) => r.status === 'invalid_token')
              ? 'invalid_tokens'
              : 'push_failed';
        }
      }

      // Inbox push'tan sonra: push yeniden denenirse kutuda kopya oluşmaz.
      if (template.channel.includes('inbox')) {
        await repo.insertInbox(db, n.userId, {
          type: n.type,
          params: n.params,
          refType: n.params.refType,
          refId: n.params.refId,
        });
      }
      const delivered = pushed || template.channel.includes('inbox');
      await finish(delivered ? 'sent' : 'skipped', { error: pushReason, category, pushed });
      return delivered ? 'sent' : 'skipped';
    },

    // ── Gelen kutusu (okuma anında kullanıcının güncel diliyle render) ─────
    async list(userId, locale, { cursor, limit = 20 }) {
      const after = decodeCursor(cursor, ['t', 'i']);
      const rows = await repo.listInbox(db, userId, {
        before: after ? { at: new Date(after.t), id: after.i } : null,
        limit,
      });
      const page = rows.slice(0, limit);
      const all = await repo.templates(db);
      const lang = localeOf(locale ?? (await repo.recipient(db, userId))?.locale);
      const items = [];
      for (const r of page) {
        const template = all[r.type];
        const text = template
          ? await renderFor(template, r.params, lang)
          : { title: r.type, body: '' };
        items.push({
          id: r.id,
          type: r.type,
          category: template?.category ?? 'system',
          title: text.title,
          body: text.body,
          params: r.params,
          iconKey: template?.iconKey ?? null,
          deepLink: template?.deepLink ?? null,
          createdAt: r.createdAt.toISOString(),
          readAt: r.readAt ? r.readAt.toISOString() : null,
        });
      }
      const last = page.at(-1);
      const hasMore = rows.length > limit;
      return {
        items,
        pageInfo: {
          nextCursor:
            hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), i: last.id }) : null,
          hasMore,
        },
      };
    },

    async unreadCount(userId) {
      return { count: await repo.unreadCount(db, userId) };
    },

    async read(userId, id) {
      if (!(await repo.markRead(db, userId, id))) throw new AppError('NOT_FOUND');
      return {};
    },

    async readAll(userId) {
      return { updated: await repo.markAllRead(db, userId) };
    },

    async remove(userId, id) {
      if (!(await repo.softDelete(db, userId, id))) throw new AppError('NOT_FOUND');
      return {};
    },

    logger,
  };
  return service;
}
