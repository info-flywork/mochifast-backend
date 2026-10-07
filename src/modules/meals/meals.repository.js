import { fromBin, toBin } from '../../shared/ids.js';
import { isoDate } from '../../shared/time.js';

const COLUMNS = `id, user_id, eaten_at, local_date, kind, slot, diet_type, feeling, title, notes_enc,
                 kcal, protein_g, carbs_g, fat_g, source, breaks_fast_session_id, photo_media_id,
                 deleted_at`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

function toMeal(r) {
  return {
    id: fromBin(r.id),
    eatenAt: r.eaten_at,
    localDate: isoDate(r.local_date),
    kind: r.kind ?? null,
    slot: r.slot ?? null,
    dietType: r.diet_type ?? null,
    feeling: r.feeling ?? null,
    title: r.title ?? null,
    notesEnc: r.notes_enc ?? null,
    kcal: r.kcal ?? null,
    proteinG: num(r.protein_g),
    carbsG: num(r.carbs_g),
    fatG: num(r.fat_g),
    source: r.source,
    breaksFastId: r.breaks_fast_session_id ? fromBin(r.breaks_fast_session_id) : null,
    photoMediaId: r.photo_media_id ? fromBin(r.photo_media_id) : null,
  };
}

/** Başka kullanıcının kaydı `{ foreign: true }` (istemci id çakışması); silinmiş olan null. */
export async function findMeal(db, userId, id, conn, { includeDeleted = false } = {}) {
  const row = await db.one(`SELECT ${COLUMNS} FROM meals WHERE id = :id`, { id: toBin(id) }, conn);
  if (!row) return null;
  if (fromBin(row.user_id) !== userId) return { foreign: true };
  if (row.deleted_at && !includeDeleted) return null;
  return toMeal(row);
}

/** API alanı → kolon (yalnızca bunlar yazılabilir). */
const WRITABLE = {
  eatenAt: 'eaten_at',
  localDate: 'local_date',
  kind: 'kind',
  slot: 'slot',
  dietType: 'diet_type',
  feeling: 'feeling',
  title: 'title',
  notesEnc: 'notes_enc',
  kcal: 'kcal',
  proteinG: 'protein_g',
  carbsG: 'carbs_g',
  fatG: 'fat_g',
  photoMediaId: 'photo_media_id',
};

export async function insertMeal(db, conn, userId, m) {
  await db.run(
    `INSERT INTO meals
       (id, user_id, eaten_at, local_date, tz, kind, slot, diet_type, feeling, title, notes_enc,
        kcal, protein_g, carbs_g, fat_g, source, photo_media_id, analysis_id)
     VALUES (:id, :userId, :eatenAt, :localDate, :tz, :kind, :slot, :dietType, :feeling, :title,
             :notesEnc, :kcal, :proteinG, :carbsG, :fatG, :source, :photoMediaId, :analysisId)`,
    {
      id: toBin(m.id),
      userId: toBin(userId),
      eatenAt: m.eatenAt,
      localDate: m.localDate,
      tz: m.tz,
      kind: m.kind ?? null,
      slot: m.slot ?? null,
      dietType: m.dietType ?? null,
      feeling: m.feeling ?? null,
      title: m.title ?? null,
      notesEnc: m.notesEnc ?? null,
      kcal: m.kcal ?? null,
      proteinG: m.proteinG ?? null,
      carbsG: m.carbsG ?? null,
      fatG: m.fatG ?? null,
      source: m.source,
      photoMediaId: m.photoMediaId ? toBin(m.photoMediaId) : null,
      analysisId: m.analysisId ? toBin(m.analysisId) : null,
    },
    conn,
  );
}

export async function updateMeal(db, conn, id, fields) {
  const keys = Object.keys(fields).filter((k) => WRITABLE[k] && fields[k] !== undefined);
  if (keys.length === 0) return;
  const params = { id: toBin(id) };
  for (const k of keys) {
    params[k] = k === 'photoMediaId' && fields[k] ? toBin(fields[k]) : fields[k];
  }
  // Kolon adları yalnızca WRITABLE sözlüğünden gelir (kullanıcı girdisi değil).
  await db.run(
    `UPDATE meals SET ${keys.map((k) => `${WRITABLE[k]} = :${k}`).join(', ')} WHERE id = :id`,
    params,
    conn,
  );
}

export async function softDeleteMeal(db, conn, id) {
  await db.run('UPDATE meals SET deleted_at = NOW(3) WHERE id = :id', { id: toBin(id) }, conn);
}

export async function mealsOfDay(db, userId, date) {
  const rows = await db.many(
    `SELECT ${COLUMNS} FROM meals
      WHERE user_id = :userId AND local_date = :date AND deleted_at IS NULL
      ORDER BY eaten_at, id`,
    { userId: toBin(userId), date },
  );
  return rows.map(toMeal);
}

/** Yeniden eskiye; imleç (eaten_at, id). */
export async function listMeals(db, userId, { from, to, before, limit }) {
  const rows = await db.many(
    `SELECT ${COLUMNS} FROM meals
      WHERE user_id = :userId AND deleted_at IS NULL
        AND (:from IS NULL OR local_date >= :from) AND (:to IS NULL OR local_date <= :to)
        AND (:beforeAt IS NULL OR eaten_at < :beforeAt
             OR (eaten_at = :beforeAt AND id < :beforeId))
      ORDER BY eaten_at DESC, id DESC
      LIMIT :limit`,
    {
      userId: toBin(userId),
      from: from ?? null,
      to: to ?? null,
      beforeAt: before?.at ?? null,
      beforeId: before ? toBin(before.id) : null,
      limit: String(limit + 1),
    },
  );
  return rows.map(toMeal);
}
