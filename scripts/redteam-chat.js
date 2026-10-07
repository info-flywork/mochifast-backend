import '../src/config/env-file.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/index.js';
import { createChatClient } from '../src/infra/openai.js';
import { formatContext } from '../src/modules/chat/chat.context.js';
import { PERSONA_VERSION, refusalText } from '../src/modules/chat/chat.service.js';
import { classifySafety } from '../src/modules/chat/chat.safety.js';

/**
 * Red-team seti (docs/backend/12-yol-haritasi.md F6): tehlikeli istek senaryoları üretimdeki
 * persona + bağlam biçimiyle GERÇEK modele gönderilir; yanıtlar beklenen davranışla yan yana
 * rapora yazılır ve ELLE gözden geçirilir (otomatik puanlama yok; karar insanındır).
 *
 *   npm run redteam:chat [-- --only ed-01,minor-01]
 *
 * Ücretlidir (vaka başına bir çağrı). Rapor: redteam/results/<persona>-<zaman>.md
 */
const { values } = parseArgs({ options: { only: { type: 'string' } } });
const config = loadConfig();
if (!config.chatAi.enabled) {
  console.error('OPENAI_API_KEY ve OPENAI_CHAT_MODEL gerekli.');
  process.exit(1);
}
const chat = createChatClient(config.chatAi);
const persona = await readFile(
  new URL(`../prompts/${PERSONA_VERSION}.md`, import.meta.url),
  'utf8',
);
let cases = JSON.parse(
  await readFile(new URL('../redteam/chat-cases.json', import.meta.url), 'utf8'),
);
if (values.only) cases = cases.filter((c) => values.only.split(',').includes(c.id));

const contextFor = (c) =>
  formatContext({
    nickname: 'Deniz',
    locale: c.locale,
    tz: 'Europe/Istanbul',
    localTime: '2026-10-07 21:00',
    plan: { displayName: '16:8', eatWindow: { start: '12:00', end: '20:00' } },
    fast: {
      startedAt: '2026-10-07T17:00:00.000Z',
      elapsedMinutes: 60,
      targetMinutes: 960,
      stage: null,
    },
    streakDays: 3,
    goal: 'lose_weight',
    weightKg: 70,
    goalWeightKg: 62,
    diet: 'everything',
    dislikes: [],
    today: { waterMl: 800, waterGoalMl: 2500, meals: 2, kcal: 1300, steps: 5000 },
    lastHunger: null,
    safety: c.safety,
    entryPoint: 'direct',
  });

const lines = [
  `# Red-team: ${PERSONA_VERSION} · ${config.chatAi.model} · ${new Date().toISOString()}`,
  '',
];
for (const c of cases) {
  let reply = '';
  let note = '';
  try {
    for await (const part of chat.stream([
      { role: 'system', content: persona },
      { role: 'user', content: `${contextFor(c)}\n\n${c.text}` },
    ])) {
      if (part.text) reply += part.text;
      if (part.final && (part.final.refusal || part.final.finishReason === 'content_filter')) {
        reply = refusalText(c.locale);
        note = ' (ret/içerik filtresi)';
      }
    }
  } catch (err) {
    reply = `HATA: ${err.message}`;
  }
  console.log(`${c.id}: ${reply.slice(0, 80).replace(/\n/g, ' ')}…`);
  lines.push(
    `## ${c.id} · ${c.category} · safety=[${c.safety.join(', ')}] · urgent=${classifySafety(c.text)}`,
    '',
    `**Kullanıcı:** ${c.text}`,
    '',
    `**Beklenen:** ${c.expect}`,
    '',
    `**Yanıt${note}:**`,
    '',
    reply,
    '',
    '**Değerlendirme:** ☐ güvenli ☐ güvensiz — not:',
    '',
  );
}
const dir = new URL('../redteam/results/', import.meta.url);
await mkdir(dir, { recursive: true });
const file = join(
  dir.pathname,
  `${PERSONA_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`,
);
await writeFile(file, lines.join('\n'));
console.log(`Rapor: ${file}`);
