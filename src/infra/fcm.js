import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

/**
 * Push: Firebase Cloud Messaging HTTP v1 (docs/backend/10-bildirimler.md §1). iOS da FCM → APNs.
 * Kimlik bilgisi yoksa gönderim devre dışıdır (inbox yine çalışır).
 */

/** Token artık geçersiz: cihazın token'ı silinmeli. */
const INVALID_TOKEN = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);
/** Yeniden denenebilir sağlayıcı hataları. */
const TRANSIENT = new Set([
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/unavailable',
  'messaging/quota-exceeded',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
]);

/**
 * Bildirim → FCM mesajları (cihaz başına). Sessiz saatte ses çalmaz (iOS passive, Android düşük
 * öncelik). Veri alanları string olmalı (FCM kuralı).
 */
export function buildMessages(tokens, { title, body, data, silent }) {
  const stringData = Object.fromEntries(
    Object.entries(data ?? {})
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  );
  return tokens.map((token) => ({
    token,
    notification: { title, body },
    data: stringData,
    android: {
      priority: silent ? 'normal' : 'high',
      notification: {
        channelId: silent ? 'quiet' : 'default',
        ...(silent ? {} : { sound: 'default' }),
      },
    },
    apns: {
      headers: { 'apns-priority': silent ? '5' : '10' },
      payload: {
        aps: silent ? { 'interruption-level': 'passive' } : { sound: 'default' },
      },
    },
  }));
}

/**
 * @param deps.sendImpl testte sahte gönderim: async (messages) => [{success, messageId?, errorCode?}]
 */
export function createPushClient(config, { sendImpl, logger } = {}) {
  let send = sendImpl;
  if (!send && config.serviceAccount) {
    // Kopya: config dondurulmuş, `cert()` nesneye yazıyor.
    const app = initializeApp({ credential: cert({ ...config.serviceAccount }) }, 'mochifast-push');
    const messaging = getMessaging(app);
    send = async (messages) => {
      const res = await messaging.sendEach(messages);
      return res.responses.map((r) => ({
        success: r.success,
        messageId: r.messageId ?? null,
        errorCode: r.error?.code ?? null,
      }));
    };
  }
  return {
    enabled: Boolean(send),
    /**
     * @returns [{token, status: 'sent'|'invalid_token'|'failed', transient, messageId, errorCode}]
     */
    async sendEach(tokens, notification) {
      if (!send || tokens.length === 0) return [];
      const results = await send(buildMessages(tokens, notification));
      return results.map((r, i) => ({
        token: tokens[i],
        status: r.success ? 'sent' : INVALID_TOKEN.has(r.errorCode) ? 'invalid_token' : 'failed',
        transient: !r.success && TRANSIENT.has(r.errorCode),
        messageId: r.messageId ?? null,
        errorCode: r.errorCode ?? null,
      }));
    },
    logger,
  };
}
