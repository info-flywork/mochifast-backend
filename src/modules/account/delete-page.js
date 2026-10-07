import { randomBytes } from 'node:crypto';
import { envelope, isoDateTimeSchema } from '../../shared/schemas.js';
import { catalogServiceFor } from '../catalog/catalog.routes.js';
import { accountServiceFor } from './account.routes.js';

/**
 * Web hesap silme (Google Play "hesap silme URL'si" şartı, 06 §8.6). Kullanıcı Google ile
 * giriş yapar (Firebase web SDK), Firebase ID token'ı `POST /v1/account/delete-request`'e gider;
 * uygulamadaki silmeyle aynı akış (7 gün bekleme, tekrar girişle geri alma).
 *
 * `FIREBASE_WEB_API_KEY` yoksa sayfa yalnızca uygulamadan silme adımlarını ve destek e-postasını
 * gösterir.
 */
const FIREBASE_JS = 'https://www.gstatic.com/firebasejs/11.0.0';

const TEXT = {
  tr: {
    title: 'MochiFast hesabını sil',
    intro:
      'Hesabın hemen kapanır, tüm verilerin (oruçlar, kilo, öğünler, fotoğraflar, sohbetler) 7 gün sonra kalıcı olarak silinir. 7 gün içinde uygulamaya tekrar giriş yaparsan silmeyi geri alabilirsin.',
    app: 'Uygulamadan: Profil → Profili Düzenle → Hesabı Sil.',
    subscription: 'Aboneliğin varsa Google Play veya App Store’dan ayrıca iptal etmelisin.',
    button: 'Google ile giriş yap ve hesabı sil',
    confirm: 'Hesabın silinsin mi? Bu işlem 7 gün sonra geri alınamaz.',
    done: 'Silme talebin alındı. Hesabın şu tarihte silinecek:',
    notFound: 'Bu Google hesabına bağlı bir MochiFast hesabı bulunamadı.',
    failed: 'Bir hata oluştu. Lütfen tekrar dene ya da bize yaz:',
    guest:
      'Misafir hesaplar yalnızca uygulamadan silinebilir; uygulama kaldırılırsa 90 gün sonra otomatik silinir.',
    contact: 'Yardım için:',
  },
  en: {
    title: 'Delete your MochiFast account',
    intro:
      'Your account is closed immediately and all your data (fasts, weight, meals, photos, chats) is permanently deleted after 7 days. Signing in to the app again within 7 days cancels the deletion.',
    app: 'In the app: Profile → Edit Profile → Delete Account.',
    subscription:
      'If you have a subscription, cancel it separately in Google Play or the App Store.',
    button: 'Sign in with Google and delete account',
    confirm: 'Delete your account? This cannot be undone after 7 days.',
    done: 'Your deletion request was received. Your account will be deleted on:',
    notFound: 'No MochiFast account is linked to this Google account.',
    failed: 'Something went wrong. Please try again or contact us:',
    guest:
      'Guest accounts can only be deleted in the app; if the app is uninstalled they are deleted automatically after 90 days.',
    contact: 'Need help?',
  },
};

const escapeHtml = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function page({ t, lang, email, firebase, nonce }) {
  const enabled = Boolean(firebase.webApiKey && firebase.projectId);
  const config = JSON.stringify({
    apiKey: firebase.webApiKey,
    authDomain: firebase.authDomain,
    projectId: firebase.projectId,
  });
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(t.title)}</title>
<style nonce="${nonce}">
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#FFF7F2;color:#2B2B2B}
  main{max-width:560px;margin:0 auto;padding:40px 20px}
  h1{font-size:24px;margin:0 0 16px}
  p{line-height:1.5}
  button{width:100%;padding:14px;border:0;border-radius:999px;background:#CC655A;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6}
  .note{font-size:14px;color:#666}
  #status{margin-top:16px;font-weight:600}
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(t.title)}</h1>
  <p>${escapeHtml(t.intro)}</p>
  <p>${escapeHtml(t.app)}</p>
  ${enabled ? `<button id="delete">${escapeHtml(t.button)}</button>` : ''}
  <p id="status" role="status"></p>
  <p class="note">${escapeHtml(t.subscription)}</p>
  <p class="note">${escapeHtml(t.guest)}</p>
  <p class="note">${escapeHtml(t.contact)} <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
</main>
${
  enabled
    ? `<script type="module" nonce="${nonce}">
import { initializeApp } from '${FIREBASE_JS}/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from '${FIREBASE_JS}/firebase-auth.js';
const t = ${JSON.stringify({ confirm: t.confirm, done: t.done, notFound: t.notFound, failed: `${t.failed} ${email}` })};
const auth = getAuth(initializeApp(${config}));
const button = document.getElementById('delete');
const status = document.getElementById('status');
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = '';
  try {
    const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
    if (!confirm(t.confirm)) return;
    const res = await fetch('/v1/account/delete-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-language': '${lang}' },
      body: JSON.stringify({ idToken: await user.getIdToken() }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const at = new Date(body.data.scheduledFor).toLocaleDateString('${lang}', { dateStyle: 'long' });
      status.textContent = t.done + ' ' + at;
      button.remove();
    } else {
      status.textContent = res.status === 404 ? t.notFound : t.failed;
    }
  } catch (err) {
    if (err?.code !== 'auth/popup-closed-by-user') status.textContent = t.failed;
  } finally {
    await signOut(auth).catch(() => {});
    if (button.isConnected) button.disabled = false;
  }
});
</script>`
    : ''
}
</body>
</html>`;
}

/** `GET /account/delete` (HTML). */
export async function deletePageRoutes(app) {
  const catalog = catalogServiceFor(app);
  app.get('/account/delete', { schema: { hide: true } }, async (request, reply) => {
    const lang = /^tr\b/i.test(request.headers['accept-language'] ?? '') ? 'tr' : 'en';
    const config = await catalog.appConfig('all').catch(() => ({}));
    const email = config.support?.email ?? 'info@fly-work.com';
    const nonce = randomBytes(16).toString('base64');
    const authDomain = app.config.firebase.authDomain;
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header(
        'content-security-policy',
        [
          "default-src 'none'",
          `script-src 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com`,
          `style-src 'nonce-${nonce}'`,
          "connect-src 'self' https://*.googleapis.com",
          `frame-src https://${authDomain} https://accounts.google.com`,
          "img-src 'self' data: https:",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      );
    return page({ t: TEXT[lang], lang, email, firebase: app.config.firebase, nonce });
  });
}

/** `POST /v1/account/delete-request` 🔓 (Firebase ID token ile). */
export async function deleteRequestRoutes(app) {
  const service = accountServiceFor(app);
  app.post(
    '/delete-request',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
      schema: {
        tags: ['user'],
        summary: 'Web hesap silme talebi (Firebase ID token; Play Store silme sayfası)',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['idToken'],
          properties: { idToken: { type: 'string', minLength: 1, maxLength: 8192 } },
        },
        response: {
          202: envelope({
            type: 'object',
            required: ['scheduledFor'],
            properties: { scheduledFor: isoDateTimeSchema },
          }),
        },
      },
    },
    async (request, reply) => {
      const { scheduledFor } = await service.requestDeletionWithIdToken(request.body.idToken, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      reply.code(202);
      return { scheduledFor };
    },
  );
}
