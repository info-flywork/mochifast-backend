import '../src/config/env-file.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/index.js';
import { costMicroUsd } from '../src/infra/anthropic.js';
import { createVisionClient } from '../src/infra/openai.js';
import { PROMPT_VERSION } from '../src/modules/ai/meal-analysis.rules.js';
import { processImage } from '../src/modules/media/media.pipeline.js';
import { analysisRequest, interpret } from '../src/modules/ai/photo-analysis.service.js';

/**
 * Fotoğraf analizi değerlendirmesi (docs/backend/09-yapay-zeka.md §3.4). Üretimdeki istek ve
 * doğrulama ile birebir aynı yolu çalıştırır; her prompt/model değişikliğinde koşulur.
 *
 *   npm run eval:meals -- --dir eval/meals [--locale tr] [--concurrency 4] [--limit 20]
 *
 * `<dir>/manifest.json`: [{ "file": "a.jpg", "isFood": true, "kcal": 540,
 *                           "proteinG": 30, "carbsG": 60, "fatG": 18 }, …]
 * Yemek dışı fotoğraflar `"isFood": false` ile (kcal gerekmez). Rapor `<dir>/results/` altına yazılır.
 * GERÇEK API çağrısı yapar ve ücretlidir: önce `--limit` ile küçük bir alt kümede deneyin.
 */
const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    locale: { type: 'string', default: 'tr' },
    concurrency: { type: 'string', default: '4' },
    limit: { type: 'string' },
  },
});
if (!values.dir) {
  console.error('Kullanım: npm run eval:meals -- --dir <klasör> [--locale tr] [--limit N]');
  process.exit(1);
}

const config = loadConfig();
if (!config.ai.enabled) {
  console.error('OPENAI_API_KEY / OPENAI_VISION_MODEL yok.');
  process.exit(1);
}
const ai = createVisionClient(config.ai);
const pricing =
  JSON.parse(await readFile(new URL('../seeds/app_config.json', import.meta.url))).find(
    (r) => r.key === 'ai.pricing',
  )?.value ?? {};

const dir = resolve(values.dir);
let cases = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
if (values.limit) cases = cases.slice(0, Number(values.limit));

async function runCase(c) {
  const started = Date.now();
  try {
    const { variants } = await processImage(await readFile(join(dir, c.file)), 'meal_photo');
    const message = await ai.create(analysisRequest(variants.lg.buffer, values.locale, config.ai), {
      timeoutMs: config.ai.analysisTimeoutMs,
    });
    const outcome = interpret(message);
    return {
      ...c,
      latencyMs: Date.now() - started,
      status: outcome.status,
      errorCode: outcome.errorCode ?? null,
      predicted: outcome.result ?? null,
      model: message.model,
      costMicroUsd: costMicroUsd(message.usage, pricing[message.model]),
    };
  } catch (err) {
    return { ...c, latencyMs: Date.now() - started, status: 'error', errorCode: err.message };
  }
}

const results = [];
const queue = [...cases];
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (queue.length > 0) {
      const c = queue.shift();
      const r = await runCase(c);
      results.push(r);
      process.stdout.write(`${results.length}/${cases.length} ${c.file} → ${r.status}\n`);
    }
  }),
);

const pct = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
};
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const round = (v, d = 3) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

const classified = results.filter((r) => ['succeeded', 'not_food'].includes(r.status));
const isFoodCorrect = classified.filter(
  (r) => (r.status === 'succeeded') === (r.isFood !== false),
).length;
const scored = results.filter((r) => r.status === 'succeeded' && r.isFood !== false && r.kcal > 0);
const macroMae = (k) =>
  round(
    mean(scored.filter((r) => r[k] !== undefined).map((r) => Math.abs(r.predicted[k] - r[k]))),
    1,
  );

const report = {
  promptVersion: PROMPT_VERSION,
  model: config.ai.visionModel,
  locale: values.locale,
  at: new Date().toISOString(),
  cases: results.length,
  failures: results.filter((r) => !['succeeded', 'not_food'].includes(r.status)).length,
  isFoodAccuracy: round(classified.length ? isFoodCorrect / classified.length : null),
  kcalMape: round(mean(scored.map((r) => Math.abs(r.predicted.kcal - r.kcal) / r.kcal))),
  macroMaeG: { protein: macroMae('proteinG'), carbs: macroMae('carbsG'), fat: macroMae('fatG') },
  latencyMs: {
    p50: pct(
      results.map((r) => r.latencyMs),
      50,
    ),
    p95: pct(
      results.map((r) => r.latencyMs),
      95,
    ),
  },
  costUsd: {
    total: round(results.reduce((a, r) => a + (r.costMicroUsd ?? 0), 0) / 1e6, 4),
    perImage: round(mean(results.map((r) => r.costMicroUsd ?? 0)) / 1e6, 5),
  },
  // Hedefler (09 §3.4): kcal MAPE ≤ 0.25, isFood ≥ 0.98, p95 < 12 sn (uçtan uca).
  targets: { kcalMape: 0.25, isFoodAccuracy: 0.98, p95LatencyMs: 12_000 },
  results,
};

await mkdir(join(dir, 'results'), { recursive: true });
const out = join(dir, 'results', `${PROMPT_VERSION}-${report.at.replace(/[:.]/g, '-')}.json`);
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
const { results: _omit, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
console.log(`Rapor: ${out}`);
