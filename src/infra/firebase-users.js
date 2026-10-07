import { cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

/**
 * Firebase Authentication kullanıcı yönetimi (hesap silme, docs/backend/06-guvenlik.md §8.3).
 * Kimlik bilgisi push ile aynı servis hesabıdır (`FCM_SERVICE_ACCOUNT_JSON`); yoksa kapalıdır ve
 * silme işi bu adımı atlar.
 *
 * Apple token iptali (`/auth/revoke`) istemcide Firebase SDK ile yapılır (06 §8.6): sunucuda
 * Apple refresh token'ı tutulmaz.
 *
 * @param config config.push
 * @param deps.deleteImpl testte sahte silme: async (uid) => void
 */
export function createFirebaseUsers(config, { deleteImpl } = {}) {
  let remove = deleteImpl;
  if (!remove && config.serviceAccount) {
    // Kopya: config dondurulmuş, `cert()` nesneye yazıyor.
    const app = initializeApp(
      { credential: cert({ ...config.serviceAccount }) },
      'mochifast-users',
    );
    const auth = getAuth(app);
    remove = (uid) => auth.deleteUser(uid);
  }
  return {
    enabled: Boolean(remove),

    /** Kullanıcıyı siler; zaten yoksa başarı sayılır. @returns silindi mi */
    async deleteUser(uid) {
      if (!remove) return false;
      try {
        await remove(uid);
        return true;
      } catch (err) {
        if (err?.code === 'auth/user-not-found') return false;
        throw err;
      }
    },
  };
}
