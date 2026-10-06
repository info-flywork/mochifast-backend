import { PLATFORMS, SUPPORTED_LOCALES } from '../../config/constants.js';
import { envelope, uuidSchema } from '../../shared/schemas.js';
import { isValidTimezone } from '../../shared/time.js';
import * as repo from './devices.repository.js';

const deviceSchema = {
  type: 'object',
  required: ['id', 'installId', 'platform', 'pushEnabled', 'hasPushToken'],
  properties: {
    id: uuidSchema,
    installId: uuidSchema,
    platform: { type: 'string' },
    pushEnabled: { type: 'boolean' },
    hasPushToken: { type: 'boolean' },
  },
};

const short = (max) => ({ type: 'string', minLength: 1, maxLength: max });

/**
 * `/v1/devices` (docs/backend/04-api.md §3).
 */
export default async function devicesRoutes(app) {
  const { db } = app.deps;

  app.put(
    '/current',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['devices'],
        summary: 'Cihazı kaydet / güncelle (her açılışta ve push token değişince)',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['installId', 'platform'],
          properties: {
            installId: uuidSchema,
            platform: { type: 'string', enum: PLATFORMS },
            osVersion: short(32),
            appVersion: short(32),
            deviceModel: short(64),
            pushToken: { type: ['string', 'null'], minLength: 1, maxLength: 512 },
            pushEnabled: { type: 'boolean' },
            locale: { type: 'string', enum: SUPPORTED_LOCALES },
            timezone: short(64),
          },
        },
        response: { 200: envelope(deviceSchema) },
      },
    },
    async (request) => {
      const body = { ...request.body };
      if (body.timezone !== undefined && !isValidTimezone(body.timezone)) delete body.timezone;
      const device = await db.withTransaction(async (conn) => {
        const d = await repo.upsertCurrentDevice(db, conn, request.user.id, body);
        if (body.pushToken) await repo.releasePushToken(db, conn, body.pushToken, d.id);
        await repo.attachSessionDevice(db, conn, request.user.id, request.user.sessionId, d.id);
        return d;
      });
      return {
        id: device.id,
        installId: device.install_id,
        platform: device.platform,
        pushEnabled: device.push_enabled,
        hasPushToken: Boolean(device.has_push_token),
      };
    },
  );

  app.delete(
    '/current/push-token',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['devices'],
        summary: 'Bu cihazın push token’ını sil',
        security: [{ bearerAuth: [] }],
        response: {
          200: envelope({ type: 'object', additionalProperties: false, properties: {} }),
        },
      },
    },
    async (request) => {
      const deviceId = await repo.findCurrentDeviceId(
        db,
        request.user.id,
        request.user.sessionId,
        request.ctx.installId,
      );
      if (deviceId) await repo.clearPushToken(db, request.user.id, deviceId);
      return {};
    },
  );
}
