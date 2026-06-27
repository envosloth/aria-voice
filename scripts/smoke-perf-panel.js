#!/usr/bin/env node
/* End-to-end verification of the Settings -> Performance latency panel.
 *
 * Boots the REAL renderer headless, fires one text turn's worth of perf marks
 * into window.AriaPerf, opens Settings, and reads back the per-stage rows + the
 * detected-hardware line — proving the panel's DOM wiring (perf.js timeline ->
 * refreshPerfPanel -> rows, plus aria.hardware.info -> renderHardware) actually
 * populates, not just that perf.js's math is correct (that's smoke-hardware.js).
 */
const { spawn } = require('child_process');
const path = require('path');

function main() {
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['--no-sandbox', path.join(__dirname, '..', 'dist', 'main', 'index.js')], {
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_VERIFY_PERF: '1' },
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
    let p = {};
    try { p = JSON.parse(marks['perf-panel'] || '{}'); } catch (e) {}
    const isMs = (s) => typeof s === 'string' && /^\d+(\.\d+)?\s*(ms|s)$/.test(s.trim());

    const checks = [
      ['panel reported back', !!marks['perf-panel']],
      // A typed turn has no audio stage -> STT shows the em-dash placeholder.
      ['STT row is "—" for a text turn', p.stt === '—'],
      // LLM + total stages must show a real measured duration (not a dash).
      ['LLM row shows a duration', isMs(p.llm)],
      ['Total row shows a duration', isMs(p.total)],
      ['LLM label names the target', typeof p.llmLabel === 'string' && /LLM/.test(p.llmLabel)],
      // Hardware line is populated by the real hardware:info IPC round-trip.
      ['hardware line populated', typeof p.hw === 'string' && /tier/.test(p.hw) && /GPU:/.test(p.hw)],
      ['GPU cap control has a numeric value', /^\d+$/.test(String(p.gpuCap || ''))],
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
