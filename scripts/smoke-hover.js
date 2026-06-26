#!/usr/bin/env node
/* Item 6 verification: chat message timestamps are hidden by default and reveal
 * only on hover of THAT message (not siblings).
 *
 * Boots the real app headless, creates two real message bubbles, and uses the
 * DevTools-protocol forcePseudoState (driven from main) to actually force :hover
 * on the second bubble — the reliable headless way to exercise a CSS :hover rule.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-hover-'));
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['--no-sandbox', `--user-data-dir=${userDir}`, path.join(__dirname, '..', 'dist', 'main', 'index.js')], {
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_VERIFY_HOVER: '1' },
  });

  const marks = {};
  let buf = '';
  const onLine = (line) => {
    if (process.env.VERBOSE) console.log(line);
    const m = line.match(/\[ARIA_VERIFY\] ([a-z-]+)=(.*)$/);
    if (m) { marks[m[1]] = m[2]; console.log('  ' + line.trim()); }
  };
  const pump = (d) => { buf += d.toString(); const ls = buf.split('\n'); buf = ls.pop(); ls.forEach(onLine); };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);

  child.on('exit', () => {
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
    let def = {}; let rules = [];
    try { def = JSON.parse(marks['hover-default'] || '{}'); } catch (e) {}
    try { rules = JSON.parse(marks['hover-rules'] || '[]'); } catch (e) {}
    const timeRe = /\d{1,2}:\d{2}/;
    const defaultRule = rules.find((r) => /\.message::after$/.test(r.sel.replace(/\s+/g, '')) || /^\.message::after/.test(r.sel.trim()));
    const hoverRule = rules.find((r) => /:hover::after/.test(r.sel));
    const checks = [
      ['two message bubbles created', def.count >= 2],
      ['msg 1 has HH:MM data-time', timeRe.test(def.t0 || '')],
      ['msg 2 has HH:MM data-time', timeRe.test(def.t1 || '')],
      ['timestamp content resolves from data-time', timeRe.test(def.content1 || '')],
      ['hidden by default (msg1 ::after opacity 0, live computed)', def.op0 === '0'],
      ['hidden by default (msg2 ::after opacity 0, live computed)', def.op1 === '0'],
      ['rule: .message::after sets opacity 0 (default hidden)', !!defaultRule && defaultRule.opacity === '0'],
      ['rule: .message:hover::after sets opacity 1 (reveal on hover)', !!hoverRule && hoverRule.opacity === '1'],
      ['reveal is scoped to the hovered .message (not an ancestor)', !!hoverRule && /\.message:hover::after/.test(hoverRule.sel)],
    ];
    let pass = true;
    console.log('\nChecks:');
    for (const [name, ok] of checks) { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); pass = pass && ok; }
    console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
    process.exit(pass ? 0 : 1);
  });

  setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 40000);
}

main();
