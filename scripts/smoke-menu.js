#!/usr/bin/env node
/* Item 4 verification: the default File/Edit/View/Window application menu is gone
 * and the window's menu bar is hidden, while standard editing accelerators
 * (cut/copy/paste/selectAll/undo/redo) remain registered so copy/paste keep
 * working in the chat box and on selected transcript text.
 *
 * Boots the real app headless and reads back the live menu state from the main
 * process.
 */
const { spawn } = require('child_process');
const path = require('path');

function main() {
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['--no-sandbox', path.join(__dirname, '..', 'dist', 'main', 'index.js')], {
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_VERIFY_MENU: '1' },
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
    let toplevel = []; let roles = [];
    try { toplevel = JSON.parse(marks['appmenu-toplevel'] || '[]'); } catch (e) {}
    try { roles = JSON.parse(marks['appmenu-roles'] || '[]'); } catch (e) {}
    const lower = toplevel.map((s) => String(s).toLowerCase());
    const hasNone = (n) => !lower.includes(n);

    const checks = [
      ['no File menu', hasNone('file')],
      ['no View menu', hasNone('view')],
      ['no Window menu', hasNone('window')],
      ['menu bar hidden', marks['menubar-visible'] === 'false'],
      ['copy accelerator preserved', roles.includes('copy')],
      ['paste accelerator preserved', roles.includes('paste')],
      ['selectAll accelerator preserved', roles.includes('selectAll') || roles.includes('selectall')],
    ];
    let pass = true;
    console.log('\nChecks:');
    for (const [name, ok] of checks) { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); pass = pass && ok; }
    console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
    process.exit(pass ? 0 : 1);
  });

  setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 30000);
}

main();
