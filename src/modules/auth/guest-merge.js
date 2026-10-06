/**
 * Misafir → mevcut hesap birleştirme adımları (docs/backend/05-is-kurallari.md §11).
 * `mergeGuest: true` ile girişte, AYNI transaction içinde sırayla çalışır:
 *   async (conn, { db, fromUserId, toUserId }) => void
 *
 * Kullanıcı verisi tutan her yeni domain (oruç, kilo, su, öğün, medya…) kendi adımını buraya ekler.
 * F1'de taşınacak kullanıcı verisi henüz yok.
 */
export const GUEST_MERGE_STEPS = [];
