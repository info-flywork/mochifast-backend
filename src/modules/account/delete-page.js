import { catalogServiceFor } from '../catalog/catalog.routes.js';

/**
 * Web hesap silme bilgi sayfası (Google Play "hesap silme URL'si" şartı, 06 §8.6). Silme
 * uygulamadan yapılır; uygulamaya erişemeyen kullanıcı destek e-postasıyla talep eder (destek,
 * yönetim API'sinden işler). Giriş/form yok: Firebase web uygulaması bilinçli olarak kullanılmaz.
 */
const TEXT = {
  tr: {
    title: 'MochiFast hesabını sil',
    intro:
      'Hesabını sildiğinde hesabın hemen kapanır, tüm verilerin (oruçlar, kilo, öğünler, fotoğraflar, sohbetler) 7 gün sonra kalıcı olarak silinir. 7 gün içinde uygulamaya tekrar giriş yaparsan silmeyi geri alabilirsin.',
    stepsTitle: 'Uygulamadan silmek için',
    steps: [
      'MochiFast uygulamasını aç.',
      'Profil → Profili Düzenle’ye git.',
      'En alttaki “Hesabı Sil”e dokun ve onayla.',
    ],
    emailTitle: 'Uygulamaya erişemiyorsan',
    email:
      'Hesabında kullandığın e-posta adresinden “Hesabımı sil” konulu bir e-posta gönder; talebini 7 gün içinde işleriz:',
    subscription:
      'Aboneliğin varsa Google Play veya App Store’dan ayrıca iptal etmelisin; hesap silmek aboneliği iptal etmez.',
    guest:
      'Misafir hesaplar uygulamadan silinebilir; uygulama kaldırılırsa 90 gün sonra otomatik silinir.',
  },
  en: {
    title: 'Delete your MochiFast account',
    intro:
      'When you delete your account it is closed immediately and all your data (fasts, weight, meals, photos, chats) is permanently deleted after 7 days. Signing in to the app again within 7 days cancels the deletion.',
    stepsTitle: 'To delete in the app',
    steps: [
      'Open the MochiFast app.',
      'Go to Profile → Edit Profile.',
      'Tap “Delete Account” at the bottom and confirm.',
    ],
    emailTitle: 'If you can’t access the app',
    email:
      'Email us from the address linked to your account with the subject “Delete my account”; we process requests within 7 days:',
    subscription:
      'If you have a subscription, cancel it separately in Google Play or the App Store; deleting your account does not cancel it.',
    guest:
      'Guest accounts can be deleted in the app; if the app is uninstalled they are deleted automatically after 90 days.',
  },
};

const escapeHtml = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function page(t, lang, email) {
  const mail = escapeHtml(email);
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t.title)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#FFF7F2;color:#2B2B2B}
  main{max-width:560px;margin:0 auto;padding:40px 20px}
  h1{font-size:24px;margin:0 0 16px}
  h2{font-size:17px;margin:24px 0 8px}
  p,li{line-height:1.5}
  .note{font-size:14px;color:#666}
  a{color:#CC655A}
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(t.title)}</h1>
  <p>${escapeHtml(t.intro)}</p>
  <h2>${escapeHtml(t.stepsTitle)}</h2>
  <ol>${t.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
  <h2>${escapeHtml(t.emailTitle)}</h2>
  <p>${escapeHtml(t.email)} <a href="mailto:${mail}?subject=Delete%20my%20account">${mail}</a></p>
  <p class="note">${escapeHtml(t.subscription)}</p>
  <p class="note">${escapeHtml(t.guest)}</p>
</main>
</body>
</html>`;
}

/** `GET /account/delete` (HTML, tr/en). */
export async function deletePageRoutes(app) {
  const catalog = catalogServiceFor(app);
  app.get('/account/delete', { schema: { hide: true } }, async (request, reply) => {
    const lang = /^tr\b/i.test(request.headers['accept-language'] ?? '') ? 'tr' : 'en';
    const config = await catalog.appConfig('all').catch(() => ({}));
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
    return page(TEXT[lang], lang, config.support?.email ?? 'info@fly-work.com');
  });
}
