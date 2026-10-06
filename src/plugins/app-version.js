import fp from 'fastify-plugin';
import { catalogServiceFor } from '../modules/catalog/catalog.routes.js';
import { AppError } from '../shared/errors.js';
import { compareVersions } from '../shared/semver.js';

/** Sürüm kontrolünden muaf yollar: sağlık, belgeler, yapılandırma (güncelleme ekranı onu okur). */
const EXEMPT = [/^\/health\//, /^\/docs/, /^\/v1\/app\/config/];

/**
 * Minimum sürüm zorlaması (docs/backend/02-mimari.md §5): `X-App-Version` + `X-Platform`
 * gönderen istemci `app.min_version` altındaysa 426 APP_UPDATE_REQUIRED.
 * Başlık göndermeyen istek (ör. yönetim paneli) kontrol edilmez. Yapılandırma okunamazsa
 * istek geçirilir (DB kesintisinde tüm uygulamayı "güncelle" ekranına düşürmemek için).
 */
export default fp(
  async function appVersion(app) {
    const service = catalogServiceFor(app);

    app.addHook('onRequest', async (request) => {
      const { appVersion: current, platform } = request.ctx;
      if (!current || !platform || EXEMPT.some((re) => re.test(request.url))) return;
      let min;
      try {
        min = (await service.appConfig(platform))['app.min_version'];
      } catch (err) {
        request.log.warn({ err }, 'min sürüm okunamadı; kontrol atlandı');
        return;
      }
      if (min && compareVersions(current, min) < 0) {
        throw new AppError('APP_UPDATE_REQUIRED', { details: { minAppVersion: min, platform } });
      }
    });
  },
  { name: 'app-version', dependencies: ['request-context'] },
);
