import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { fromBin, toBin } from '../../shared/ids.js';

/**
 * Veri dışa aktarma içeriği (docs/backend/06-guvenlik.md §8.2): her domain JSON, tablo biçimli
 * olanlar ayrıca CSV, fotoğraflar WebP. Kullanıcıya ait her tablo ya burada ya da
 * EXPORT_EXCLUDED'dadır (test bunu zorlar: yeni tablo eklenince karar verilmeli).
 */

/** table → dosya adı; `key`: kullanıcı kolonu; `omit`: dışarı verilmeyen kolonlar. */
export const EXPORT_TABLES = Object.freeze([
  {
    table: 'users',
    file: 'account',
    key: 'id',
    single: true,
    omit: ['status', 'deleted_at', 'avatar_media_id'],
  },
  { table: 'user_profiles', file: 'profile', single: true },
  { table: 'user_settings', file: 'settings', single: true },
  { table: 'user_goals', file: 'goals', single: true },
  { table: 'user_stats', file: 'stats', single: true },
  { table: 'user_food_preferences', file: 'food_preferences' },
  { table: 'user_obstacles', file: 'obstacles' },
  { table: 'onboarding_submissions', file: 'onboarding_answers' },
  { table: 'user_consents', file: 'consents', omit: ['ip'] },
  { table: 'auth_identities', file: 'sign_in_methods' },
  { table: 'devices', file: 'devices', omit: ['push_token'] },
  {
    table: 'sessions',
    file: 'sessions',
    omit: ['token_hash', 'family_id', 'replaced_by_id', 'ip'],
  },
  { table: 'user_plans', file: 'plans' },
  { table: 'plan_day_checkins', file: 'plan_checkins' },
  { table: 'fasting_sessions', file: 'fasts', csv: true },
  { table: 'struggle_events', file: 'struggles', csv: true },
  { table: 'weight_entries', file: 'weights', csv: true },
  { table: 'water_entries', file: 'water', csv: true },
  { table: 'step_daily', file: 'steps', csv: true },
  { table: 'sleep_entries', file: 'sleep', csv: true },
  { table: 'meals', file: 'meals', csv: true },
  { table: 'hunger_checkins', file: 'hunger_checkins', csv: true },
  { table: 'daily_summaries', file: 'daily_summaries', csv: true },
  { table: 'xp_events', file: 'xp_events' },
  { table: 'user_world_zones', file: 'world_zones' },
  { table: 'challenge_participants', file: 'challenges' },
  { table: 'food_photo_analyses', file: 'photo_analyses' },
  { table: 'chat_conversations', file: 'chat_conversations' },
  { table: 'chat_messages', file: 'chat_messages' },
  { table: 'subscriptions', file: 'subscriptions' },
  { table: 'notifications', file: 'notifications' },
  {
    table: 'media',
    file: 'photos',
    key: 'owner_user_id',
    omit: ['storage_path', 'variants', 'sha256'],
  },
]);

/** Kullanıcı kolonu olan ama dışa aktarılmayan tablolar (teknik/geçici kayıt). */
export const EXPORT_EXCLUDED = Object.freeze({
  idempotency_keys: 'tekrar koruması, 24 saat',
  ai_quota_daily: 'günlük sayaç',
  ai_usage_daily: 'maliyet muhasebesi (iç)',
  scheduled_notifications: 'gönderim kuyruğu',
  push_deliveries: 'teslim kaydı, 30 gün',
  data_export_requests: 'bu dosyanın kendisi',
  account_deletion_requests: 'hukuki iz (silme talebi)',
  user_activity_daily: 'etkinlik sayacı (raporlar)',
});

/** Şifreli kolonların AAD bağlamı: `<tablo>.<alan>:<id>` (servislerle aynı). */
const ENC_FIELD = { rolling_summary_enc: 'summary' };

const isIdColumn = (col) => col === 'id' || col.endsWith('_id');

function plain(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && /^[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** DB satırı → dışa aktarma nesnesi: id'ler UUID, şifreli alanlar çözülmüş, sırlar çıkarılmış. */
function exportRow(row, spec, crypto, logger) {
  const omit = new Set(spec.omit ?? []);
  const key = spec.key ?? 'user_id';
  const out = {};
  const rowId = Buffer.isBuffer(row.id) && row.id.length === 16 ? fromBin(row.id) : row.id;
  for (const [col, value] of Object.entries(row)) {
    if (omit.has(col) || (col === key && col !== 'id')) continue;
    if (col.endsWith('_enc')) {
      const field = ENC_FIELD[col] ?? col.slice(0, -4);
      let text = null;
      if (value) {
        try {
          text = crypto.decrypt(value, `${spec.table}.${field}:${rowId}`);
        } catch (err) {
          logger?.warn({ err, table: spec.table }, 'dışa aktarmada şifreli alan çözülemedi');
        }
      }
      out[field] = text;
    } else if (Buffer.isBuffer(value)) {
      if (value.length === 16 && isIdColumn(col)) out[col] = fromBin(value);
      // Diğer ikili alanlar (ör. IP) verilmez.
    } else {
      out[col] = plain(value);
    }
  }
  return out;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows) {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\n')}\n`;
}

const README = `MochiFast data export / MochiFast veri dışa aktarımı

data/*.json   All data we store about you, one file per area.
              Hakkında sakladığımız tüm veriler, her alan için bir dosya.
csv/*.csv     The same tables in spreadsheet format (fasts, weights, water, meals...).
              Aynı tablolar hesap tablosu biçiminde (oruçlar, kilo, su, öğünler...).
photos/       Your meal photos and avatar (WebP).
              Öğün fotoğrafların ve profil fotoğrafın (WebP).

Times are UTC (ISO 8601). Weights in kg, water in ml, heights in cm.
Saatler UTC'dir (ISO 8601). Kilo kg, su ml, boy cm cinsindendir.
`;

/**
 * Zip'i bellekte üretir. Fotoğraflar sıkıştırılmaz (WebP zaten sıkıştırılmış).
 * @returns {Buffer} zip içeriği
 */
export async function buildExportZip({ db, storage, crypto, logger }, userId, now = new Date()) {
  const files = { 'README.txt': [strToU8(README), { level: 6 }] };
  const manifest = { userId, generatedAt: now.toISOString(), files: [] };

  for (const spec of EXPORT_TABLES) {
    const key = spec.key ?? 'user_id';
    // Tablo/kolon adları sabit listeden gelir (kullanıcı girdisi değil).
    const rows = await db.many(`SELECT * FROM ${spec.table} WHERE ${key} = :userId`, {
      userId: toBin(userId),
    });
    const data = rows.map((r) => exportRow(r, spec, crypto, logger));
    const json = spec.single ? (data[0] ?? null) : data;
    files[`data/${spec.file}.json`] = [strToU8(JSON.stringify(json, null, 2)), { level: 6 }];
    manifest.files.push(`data/${spec.file}.json`);
    if (spec.csv && data.length > 0) {
      files[`csv/${spec.file}.csv`] = [strToU8(toCsv(data)), { level: 6 }];
      manifest.files.push(`csv/${spec.file}.csv`);
    }
  }

  // Fotoğraflar: hazır kullanıcı medyasının en büyük varyantı.
  const photos = await db.many(
    `SELECT id, purpose, CAST(variants AS CHAR) AS variants FROM media
      WHERE owner_user_id = :userId AND status = 'ready' AND purpose IN ('avatar', 'meal_photo')`,
    { userId: toBin(userId) },
  );
  for (const p of photos) {
    const variants = JSON.parse(p.variants ?? '{}');
    const path = variants.lg ?? variants.md ?? Object.values(variants)[0];
    if (!path) continue;
    const name = `photos/${p.purpose === 'avatar' ? 'avatar' : 'meals'}/${fromBin(p.id)}.webp`;
    try {
      files[name] = [new Uint8Array(await storage.private.get(path)), { level: 0 }];
      manifest.files.push(name);
    } catch (err) {
      logger?.warn({ err, mediaId: fromBin(p.id) }, 'dışa aktarmada fotoğraf okunamadı');
    }
  }

  files['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];
  return Buffer.from(zipSync(files));
}

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
