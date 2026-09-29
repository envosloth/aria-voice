// In-app classifier measurement (ARIA_VERIFY_CLASSIFIER=1).
//
// The tiebreaker is only worth its latency if the configured chat model answers
// the one-word question fast. This runs that exact call — same endpoint, same
// model, same key, same deadline as production — against the utterances the
// heuristic router cannot classify, and prints accuracy plus latency.
//
// Measure with YOUR model, not a stand-in:
//   ARIA_VERIFY_CLASSIFIER=1 ./node_modules/.bin/electron --no-sandbox dist/main/index.js
// Then quit ARIA; the report is on stdout and in the log.
//
// It makes one tiny request per unsure utterance (a few hundred tokens total)
// and never touches the conversation or the UI.

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { config } from './config';
import { getSecret } from './secure-storage';
import { routeDetailed } from './router';
import { classifyTurn, CoordinatorId } from './turn-classifier';
import { perfMark } from './perf';

const CASE_FILES = ['routing-cases.json', 'routing-cases-h5.json', 'routing-cases-h6.json'];
const CONCURRENCY = 4;

interface Case { text: string; expect: string; cat?: string; ctx?: Record<string, unknown> }

// The case files live next to the sources in dev and inside the packaged app
// in production, and getAppPath() disagrees between the two, so try the likely
// roots in order rather than trusting one.
function scriptsDir(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'scripts'),
    path.join(__dirname, '..', '..', 'scripts'),
    path.join(process.cwd(), 'scripts'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(path.join(c, 'routing-cases.json')).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

function loadCases(): Case[] {
  const dir = scriptsDir();
  if (!dir) return [];
  const cases: Case[] = [];
  for (const f of CASE_FILES) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { cases?: Case[]; continuations?: Case[] };
      cases.push(...(d.cases || []), ...(d.continuations || []));
    } catch {
      // A missing case file just narrows the sample; never fatal.
    }
  }
  return cases;
}

export async function runClassifierCheck(): Promise<void> {
  const endpoint = config.get('llm.endpoint') as string;
  const model = (config.get('llm.model') as string) || undefined;
  const timeoutMs = Number(config.get('routing.classifierTimeoutMs')) || 1500;
  const coordinator = ((config.get('routing.coordinator') as CoordinatorId) || 'builtin');
  let apiKey: string | null = null;
  let jevKey: string | null = null;
  try { apiKey = getSecret('llm-api-key') || null; } catch { apiKey = null; }
  try { jevKey = getSecret('jev-api-key') || null; } catch { jevKey = null; }
  const jevEndpoint = (config.get('routing.jevEndpoint') as string) || undefined;
  const jevModel = (config.get('routing.jevModel') as string) || undefined;

  const cases = loadCases();
  if (!cases.length) { console.log('[classifier-check] no case files found; nothing to measure'); return; }
  if (!endpoint) { console.log('[classifier-check] no chat endpoint configured; nothing to measure'); return; }

  const both = { mode: 'auto' as const, hasLlm: true, hasHarness: true };
  const unsure = cases
    .map((c) => ({ ...c, decision: routeDetailed(c.text, { ...both, ...(c.ctx || {}) }) }))
    .filter((c) => !c.decision.confident);

  console.log(`[classifier-check] coordinator ${coordinator}`);
  if (coordinator === 'jev') {
    console.log(`[classifier-check] jev ${jevEndpoint || '(default)'} · ${jevModel || '(default)'}${jevKey ? '' : ' · NO KEY (will fall back)'}`);
    console.log(`[classifier-check] fallback ${endpoint || '(none)'} · ${model || '(default)'}, deadline ${timeoutMs}ms`);
  } else {
    console.log(`[classifier-check] endpoint ${endpoint}`);
    console.log(`[classifier-check] model ${model || '(default)'}, deadline ${timeoutMs}ms`);
  }
  console.log(`[classifier-check] ${cases.length} utterances, ${unsure.length} unclassifiable by rule\n`);

  let i = 0;
  const results: Array<{ text: string; expect: string; heuristic: string; picked: string | null; by: string; ms: number }> = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < unsure.length) {
      const c = unsure[i++];
      const t0 = Date.now();
      const verdict = await classifyTurn(c.text, {
        coordinator,
        timeoutMs,
        llm: endpoint ? { endpoint, model, apiKey } : undefined,
        jev: coordinator === 'jev' ? { endpoint: jevEndpoint, model: jevModel, apiKey: jevKey } : undefined,
      });
      results.push({
        text: c.text, expect: c.expect, heuristic: c.decision.target,
        picked: verdict?.target || null, by: verdict?.by || 'none', ms: Date.now() - t0,
      });
    }
  }));

  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length * 0.5)] || 0;
  const p95 = lat[Math.floor(lat.length * 0.95)] || 0;
  const answered = results.filter((r) => r.picked);
  const correct = answered.filter((r) => r.picked === r.expect);
  const heurOk = results.filter((r) => r.heuristic === r.expect);
  const fixed = answered.filter((r) => r.picked === r.expect && r.heuristic !== r.expect);
  const broke = answered.filter((r) => r.picked !== r.expect && r.heuristic === r.expect);

  console.log(`  answered before the deadline   ${answered.length}/${results.length}`);
  console.log(`  classifier accuracy            ${correct.length}/${answered.length} answered${answered.length ? ` = ${((100 * correct.length) / answered.length).toFixed(1)}%` : ''}`);
  console.log(`  heuristic on the same subset   ${heurOk.length}/${results.length}${results.length ? ` = ${((100 * heurOk.length) / results.length).toFixed(1)}%` : ''}`);
  console.log(`  verdicts flipped               ${fixed.length + broke.length} (fixed ${fixed.length}, broke ${broke.length})`);
  console.log(`  latency                        p50 ${p50}ms, p95 ${p95}ms`);
  const byCount = results.reduce<Record<string, number>>((acc, r) => { acc[r.by] = (acc[r.by] || 0) + 1; return acc; }, {});
  console.log(`  answered by                    ${Object.entries(byCount).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  budget ${timeoutMs}ms: ${answered.length === results.length
    ? 'every call fit — the tiebreaker is a net win with this model'
    : `${results.length - answered.length} call(s) missed it and fell back to the heuristic; a faster model (or a larger routing.classifierTimeoutMs) would pay off more`}\n`);
  perfMark('classifier-check', 'done', { unsure: results.length, answered: answered.length, p50 });
}
