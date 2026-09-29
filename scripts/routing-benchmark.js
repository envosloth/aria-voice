#!/usr/bin/env node
/* Routing accuracy benchmark.
 *
 * Runs the real `route()` over a labeled set of realistic spoken utterances
 * (scripts/routing-cases.json) with BOTH a chat model and an agent configured —
 * the only configuration where the decision actually matters — and grades it.
 *
 * Bar (all must hold to pass) on the FITTED sets (dev + the first two independent
 * sets, which the rules were tuned against):
 *   - overall accuracy                >= 95%
 *   - every set >= 95%
 *   - every category >= 90% (the 'ambiguous' category >= 80%: its labelers marked
 *     those two-way themselves, so demanding more would measure luck)
 *   - chat over-routing to the agent  <= 5%
 *   - agent under-routing to chat     <= 5%
 * and on files after `--holdout` (never used for tuning):
 *   - overall >= 90%, every category >= 80%, each mis-route direction <= 10%
 *   - 'ambiguous' cases are printed but excluded from the holdout bars: the
 *     correct answer for them depends on the previous turn, which a
 *     single-utterance benchmark cannot supply (the app always has one)
 *
 * Tuning history (kept here so a number is never read as better than it is):
 *   sets b, c, h1-h6 were graded in sequence; each fresh set measured 75-90%
 *   unseen and the rules were then extended for the classes it exposed, which
 *   makes that set fitted from then on. The last clean unseen measurement was
 *   h6 at 81.7% by rule (87.5% with the model tiebreaker), and the rules were
 *   changed again afterwards, so h6 is now a regression set too. Every case file
 *   in this repo is therefore fitted; the fitted corpus reads ~98-99%, and that
 *   gap to the unseen numbers is the real state of this heuristic router.
 *
 * Honesty rules: a set used while tuning is never reported as a holdout; cases
 * this project deliberately decides the other way live in
 * scripts/routing-disputes.json where they are PRINTED and excluded from the
 * bar, each with a written ruling, and the list is kept tiny.
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
// A set that the rules were never fitted to is graded with its own, still
// demanding, floor: 90% overall, 80% per category, <=10% per mis-route
// direction. Files listed after --holdout use it.
const HOLDOUT_BAR = { overall: 90, category: 80, over: 10, under: 10 };
const holdoutIdx = process.argv.indexOf('--holdout');
const holdoutFiles = new Set(
  holdoutIdx >= 0
    ? process.argv.slice(holdoutIdx + 1).filter((a) => a.endsWith('.json'))
      .map((a) => path.basename(path.isAbsolute(a) ? a : path.join(process.cwd(), a)))
    : [],
);

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
const holdoutRows = rows.filter((r) => holdoutFiles.has(r.set));
const holdoutGraded = holdoutRows.filter((r) => !r.disputed);
const holdoutAcc = pct(holdoutGraded.filter((r) => r.got === r.expect).length, holdoutGraded.length);
const holdoutCats = [...new Set(holdoutGraded.map((r) => r.cat).filter((c) => c !== 'ambiguous'))].map((cat) => {
  const rs = holdoutGraded.filter((r) => r.cat === cat);
  return { cat, acc: pct(rs.filter((r) => r.got === r.expect).length, rs.length), failures: rs.filter((r) => r.got !== r.expect) };
});
const holdoutOver = pct(holdoutGraded.filter((r) => isChat(r) && r.got === 'harness').length, holdoutGraded.filter(isChat).length || 1);
const holdoutUnder = pct(holdoutGraded.filter((r) => !isChat(r) && r.got === 'llm').length, holdoutGraded.filter((r) => !isChat(r)).length || 1);

const checks = [
  ['overall >= 95% (fitted sets)', overall >= BAR.overall],
  ['every fitted set >= 95%', setStats.filter((s) => !holdoutFiles.has(`${s.name}.json`)).every((s) => s.acc >= BAR.set)],
  ['every category >= 90% (ambiguous >= 80%)',
    catStats.every((c) => c.acc >= (c.cat === 'ambiguous' ? BAR.ambiguous : BAR.category))],
  ['chat over-routing <= 5%', overPct <= BAR.over],
  ['agent under-routing <= 5%', underPct <= BAR.under],
];
if (holdoutFiles.size) {
  checks.push(
    [`holdout >= ${HOLDOUT_BAR.overall}% (never fitted)`, holdoutAcc >= HOLDOUT_BAR.overall],
    [`holdout categories >= ${HOLDOUT_BAR.category}%`, holdoutCats.every((c) => c.acc >= HOLDOUT_BAR.category)],
    [`holdout chat->agent <= ${HOLDOUT_BAR.over}%`, holdoutOver <= HOLDOUT_BAR.over],
    [`holdout agent->chat <= ${HOLDOUT_BAR.under}%`, holdoutUnder <= HOLDOUT_BAR.under],
  );
}
if (holdoutFiles.size) {
  console.log(`\nHOLDOUT-GRADED sets (not part of the fitted corpus) — ${holdoutGraded.length} utterances`);
  console.log('  NOTE: a set is only truly UNSEEN if it was generated after the last router');
  console.log('  change. Sets used while tuning are still graded here, so read the per-file');
  console.log('  numbers above and the reported tuning history, not this pooled figure alone.');
  console.log(`  accuracy            ${holdoutAcc.toFixed(1)}%  (bar >= ${HOLDOUT_BAR.overall}%)`);
  console.log(`  chat -> agent       ${holdoutOver.toFixed(1)}%  (bar <= ${HOLDOUT_BAR.over}%)`);
  console.log(`  agent -> chat       ${holdoutUnder.toFixed(1)}%  (bar <= ${HOLDOUT_BAR.under}%)`);
  for (const c of holdoutCats.filter((c) => c.acc < HOLDOUT_BAR.category).sort((a, b) => a.acc - b.acc)) {
    console.log(`  ! ${c.cat} ${c.acc.toFixed(1)}%`);
    for (const f of c.failures) console.log(`      "${f.text}" -> ${f.got} (want ${f.expect})`);
  }
}
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
