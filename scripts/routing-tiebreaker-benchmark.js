#!/usr/bin/env node
/* Tiebreaker benchmark: what the chat-model second opinion actually buys.
 *
 * Grades every labeled utterance twice:
 *   heuristic     — routeDetailed() alone
 *   with tiebreak — routeDetailed(), and where it is NOT confident, a real
 *                   one-shot classifier call (turn-classifier.ts)
 *
 * The classifier needs a live OpenAI-compatible chat endpoint. Point it at
 * yours with env vars:
 *   ARIA_TIEBREAKER_ENDPOINT   default http://127.0.0.1:8642/v1/chat/completions
 *   ARIA_TIEBREAKER_KEY        bearer token (required for a local gateway)
 *   ARIA_TIEBREAKER_MODEL      optional model name
 *   ARIA_TIEBREAKER_TIMEOUT_MS default 8000 (generous for measurement; the
 *                              production path caps at 2500ms and falls back)
 *   ARIA_TIEBREAKER_CONCURRENCY default 6
 *
 * Usage: node scripts/routing-tiebreaker-benchmark.js [case files...]
 * Requires `npm run build` first.
 */
const fs = require('fs');
const path = require('path');
const { routeDetailed } = require('../dist/main/router');
const { classifyTarget } = require('../dist/main/turn-classifier');

const both = { mode: 'auto', hasLlm: true, hasHarness: true };
const endpoint = process.env.ARIA_TIEBREAKER_ENDPOINT || 'http://127.0.0.1:8642/v1/chat/completions';
const apiKey = process.env.ARIA_TIEBREAKER_KEY || null;
const model = process.env.ARIA_TIEBREAKER_MODEL || undefined;
const timeoutMs = Number(process.env.ARIA_TIEBREAKER_TIMEOUT_MS || 8000);
const concurrency = Math.max(1, Number(process.env.ARIA_TIEBREAKER_CONCURRENCY || 6));

const files = process.argv.filter((a) => a.endsWith('.json')).map((a) => (path.isAbsolute(a) ? a : path.join(process.cwd(), a)));
const setFiles = files.length ? files : fs.readdirSync(__dirname).filter((f) => /^routing-(cases|adversarial)/.test(f) && f.endsWith('.json')).map((f) => path.join(__dirname, f));

const cases = [];
for (const f of setFiles) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const c of [...(d.cases || []), ...(d.continuations || [])]) cases.push({ ...c, set: path.basename(f) });
}

const pct = (n, d) => (d ? (100 * n) / d : 100);

async function pool(items, worker, limit) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }));
  return out;
}

(async () => {
  console.log(`Tiebreaker benchmark — ${cases.length} utterances from ${setFiles.length} sets`);
  console.log(`classifier endpoint: ${endpoint}`);
  console.log(`timeout ${timeoutMs}ms, concurrency ${concurrency}, key ${apiKey ? 'supplied' : 'none'}\n`);

  const heuristic = cases.map((c) => {
    const ctx = c.cat === 'continuation' ? { lastTarget: 'harness', ...(c.ctx || {}) } : (c.ctx || {});
    const d = routeDetailed(c.text, { ...both, ...ctx });
    return { ...c, heuristic: d.target, confident: d.confident, reason: d.reason };
  });

  const unsure = heuristic.filter((c) => !c.confident);
  console.log(`unsure (heuristic asked for help): ${unsure.length} of ${heuristic.length} = ${pct(unsure.length, heuristic.length).toFixed(1)}%\n`);

  const started = Date.now();
  const classified = await pool(unsure, async (c) => {
    const t0 = Date.now();
    const picked = await classifyTarget(c.text, { endpoint, apiKey, model, timeoutMs });
    return { ...c, picked, ms: Date.now() - t0 };
  }, concurrency);
  const elapsed = Date.now() - started;

  const latencies = classified.map((c) => c.ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;

  const resolved = classified.filter((c) => c.picked);
  const changed = resolved.filter((c) => c.picked !== c.heuristic);
  const fixed = changed.filter((c) => c.picked === c.expect);
  const broke = changed.filter((c) => c.heuristic === c.expect);

  const byText = new Map(classified.map((c) => [c.text, c]));
  const withTiebreak = heuristic.map((c) => {
    const t = byText.get(c.text);
    return t && t.picked ? t.picked : c.heuristic;
  });
  const heurOk = heuristic.filter((c) => c.heuristic === c.expect).length;
  const tbOk = withTiebreak.filter((t, i) => t === heuristic[i].expect).length;

  console.log('overall accuracy');
  console.log(`  heuristic only        ${heurOk}/${heuristic.length} = ${pct(heurOk, heuristic.length).toFixed(1)}%`);
  console.log(`  with tiebreaker       ${tbOk}/${heuristic.length} = ${pct(tbOk, heuristic.length).toFixed(1)}%`);
  console.log('');
  console.log('on the unsure subset');
  const unsureHeurOk = unsure.filter((c) => c.heuristic === c.expect).length;
  const unsureTbOk = resolved.filter((c) => c.picked === c.expect).length;
  console.log(`  heuristic             ${unsureHeurOk}/${unsure.length} = ${pct(unsureHeurOk, unsure.length).toFixed(1)}%`);
  console.log(`  classifier answered   ${resolved.length}/${unsure.length} (${pct(resolved.length, unsure.length).toFixed(1)}%), correct ${unsureTbOk}/${resolved.length} = ${pct(unsureTbOk, resolved.length).toFixed(1)}%`);
  console.log(`  flipped verdicts      ${changed.length} (fixed ${fixed.length}, broke ${broke.length})`);
  console.log(`  classifier latency    p50 ${p50}ms, p95 ${p95}ms (total wall ${(elapsed / 1000).toFixed(1)}s)`);
  const withinCap = resolved.filter((c) => c.ms <= 2500);
  console.log(`  answered within the production 2500ms cap: ${withinCap.length}/${resolved.length}`);
  console.log('');
  console.log('by set');
  for (const set of [...new Set(heuristic.map((c) => c.set))]) {
    const idx = heuristic.map((c, i) => [c, i]).filter(([c]) => c.set === set);
    const h = idx.filter(([c]) => c.heuristic === c.expect).length;
    const t = idx.filter(([c], k) => withTiebreak[idx[k][1]] === c.expect).length;
    console.log(`  ${set.padEnd(26)} heuristic ${String(h).padStart(3)}/${String(idx.length).padEnd(3)} ${pct(h, idx.length).toFixed(1).padStart(5)}%   with tiebreak ${String(t).padStart(3)}/${String(idx.length).padEnd(3)} ${pct(t, idx.length).toFixed(1).padStart(5)}%`);
  }

  const misses = heuristic.map((c, i) => [c, withTiebreak[i]]).filter(([c, t]) => t !== c.expect);
  if (misses.length) {
    console.log('\nstill wrong after the tiebreaker:');
    for (const [c, t] of misses) console.log(`  [${c.expect}] "${c.text}" -> ${t} (${c.reason})`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
