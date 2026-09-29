#!/usr/bin/env node
/* Routing accuracy benchmark.
 *
 * Runs the real `route()` over a labeled set of realistic spoken utterances
 * (scripts/routing-cases.json) with BOTH a chat model and an agent configured —
 * the only configuration where the decision actually matters — and grades it.
 *
 * Bar (all must hold to pass):
 *   - overall accuracy            >= 95%
 *   - every category's accuracy   >= 90%
 *   - chat over-routing to the agent  <= 5%  (chat cases sent to the agent)
 *   - agent under-routing to chat     <= 5%  (agent cases sent to the chat model)
 *
 * Usage: node scripts/routing-benchmark.js [--verbose] [--json out.json]
 * Requires `npm run build` first (reads dist/main/router.js).
 */
const fs = require('fs');
const path = require('path');
const { route } = require('../dist/main/router');

// The bar. 'ambiguous' gets a lower floor on purpose: the labelers marked those
// utterances two-way themselves, so demanding 90% there would measure luck.
const BAR = { overall: 95, set: 95, category: 90, ambiguous: 80, over: 5, under: 5 };

const verbose = process.argv.includes('--verbose');
const jsonIdx = process.argv.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? process.argv[jsonIdx + 1] : null;

// Dev set (tuned against) is always loaded; any files passed as arguments are
// treated as extra/independent sets and reported separately so a tuned score
// can never be confused with a genuine one.
const devFile = path.join(__dirname, 'routing-cases.json');
const extraFiles = process.argv
  .filter((a) => a.endsWith('.json') && !a.startsWith('--'))
  .map((a) => (path.isAbsolute(a) ? a : path.join(process.cwd(), a)));
const both = { mode: 'auto', hasLlm: true, hasHarness: true };

function loadSet(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  return [...(d.cases || []), ...(d.continuations || [])].map((c) => ({ ...c, set: path.basename(file) }));
}
const devCases = loadSet(devFile);
const extraCases = extraFiles.flatMap(loadSet);
const all = [...devCases, ...extraCases];

// Documented disagreements with an independent labeler are reported but kept out
// of the pass/fail math (see scripts/routing-disputes.json).
const disputes = new Set(
  (JSON.parse(fs.readFileSync(path.join(__dirname, 'routing-disputes.json'), 'utf8')).cases || [])
    .filter((d) => !d.set || extraFiles.some((f) => path.basename(f) === d.set) || d.set === path.basename(devFile))
    .map((d) => d.text),
);

const rows = all.map((c) => {
  // A continuation is by definition a follow-up to the previous turn, so it is
  // graded with that turn's target in context; anything else starts fresh.
  const ctx = c.cat === 'continuation' ? { lastTarget: 'harness', ...(c.ctx || {}) } : (c.ctx || {});
  const cfg = { ...both, ...ctx };
  return { ...c, got: route(c.text, cfg), disputed: disputes.has(c.text) };
});

const pct = (n, d) => (d ? (100 * n) / d : 100);
const graded = rows.filter((r) => !r.disputed);

const byCat = new Map();
for (const r of graded) {
  if (!byCat.has(r.cat)) byCat.set(r.cat, []);
  byCat.get(r.cat).push(r);
}
const correct = graded.filter((r) => r.got === r.expect).length;
const overall = pct(correct, graded.length);

const isChat = (r) => r.expect === 'llm';
const overRouted = graded.filter((r) => isChat(r) && r.got === 'harness');
const underRouted = graded.filter((r) => !isChat(r) && r.got === 'llm');
const overPct = pct(overRouted.length, graded.filter(isChat).length);
const underPct = pct(underRouted.length, graded.filter((r) => !isChat(r)).length);

const catStats = [...byCat.entries()].map(([cat, rs]) => {
  const ok = rs.filter((r) => r.got === r.expect).length;
  const expect = rs[0].expect;
  return { cat, expect, total: rs.length, ok, acc: pct(ok, rs.length), failures: rs.filter((r) => r.got !== r.expect) };
}).sort((a, b) => a.acc - b.acc || a.cat.localeCompare(b.cat));

console.log(`Routing accuracy benchmark — ${rows.length} utterances (both targets configured)`);
console.log(`  dev set: ${devCases.length} (${path.basename(devFile)})`);
for (const f of extraFiles) console.log(`  extra:   ${loadSet(f).length} (${path.basename(f)})`);
console.log('');
// Per-set scores, so an independent set is never averaged into the tuned one.
const sets = [['dev', devCases], ...extraFiles.map((f) => [path.basename(f, '.json'), loadSet(f)])];
console.log('per-set accuracy');
for (const [name, cases] of sets) {
  const got = graded.filter((r) => cases.some((c) => c.text === r.text));
  const ok = got.filter((r) => r.got === r.expect).length;
  const catMin = Math.min(...[...new Set(got.map((r) => r.cat))].map((cat) => {
    const rs = got.filter((r) => r.cat === cat);
    return (100 * rs.filter((r) => r.got === r.expect).length) / rs.length;
  }));
  console.log(`  ${name.padEnd(22)} ${String(ok).padStart(3)}/${String(got.length).padEnd(3)} ${pct(ok, got.length).toFixed(1).padStart(5)}%  worst category ${catMin.toFixed(1)}%`);
}
console.log('');
for (const c of catStats) {
  const floor = c.cat === 'ambiguous' ? BAR.ambiguous : BAR.category;
  const flag = c.acc >= floor ? ' ' : '!';
  console.log(`${flag} ${c.cat.padEnd(22)} ${String(c.ok).padStart(3)}/${String(c.total).padEnd(3)} ${c.acc.toFixed(1).padStart(5)}%  (${c.expect})`);
  for (const f of c.failures) {
    console.log(`      ${c.acc >= 90 ? '·' : '✗'} "${f.text}" -> ${f.got} (want ${f.expect})`);
  }
}
if (disputes.size) {
  for (const r of rows.filter((x) => x.disputed)) console.log(`  DISPUTED (not graded): "${r.text}" -> ${r.got} (router) vs ${r.expect} (other labeler)`);
}
console.log(`\noverall            ${correct}/${graded.length} = ${overall.toFixed(1)}%`);
console.log(`chat sent to agent ${overRouted.length} = ${overPct.toFixed(1)}%  (bar <= 5%)`);
console.log(`agent sent to chat ${underRouted.length} = ${underPct.toFixed(1)}%  (bar <= 5%)`);

const setStats = sets.map(([name, cases]) => {
  const got = graded.filter((r) => cases.some((c) => c.text === r.text));
  return { name, total: got.length, acc: pct(got.filter((r) => r.got === r.expect).length, got.length) };
});
const checks = [
  ['overall >= 95%', overall >= BAR.overall],
  ['every independent set >= 95%', setStats.every((s) => s.acc >= BAR.set)],
  ['every category >= 90% (ambiguous >= 80%)',
    catStats.every((c) => c.acc >= (c.cat === 'ambiguous' ? BAR.ambiguous : BAR.category))],
  ['chat over-routing <= 5%', overPct <= BAR.over],
  ['agent under-routing <= 5%', underPct <= BAR.under],
];
console.log('');
for (const [name, ok] of checks) console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ overall, overPct, underPct, catStats, rows }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
if (verbose) {
  console.log('\nAll mismatches:');
  for (const r of rows.filter((r) => r.got !== r.expect)) console.log(`  [${r.cat}] "${r.text}" -> ${r.got} (want ${r.expect})`);
}

const pass = checks.every(([, ok]) => ok);
console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
