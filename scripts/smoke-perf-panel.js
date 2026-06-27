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
const os = require('os');
const fs = require('fs');

function main() {
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  // Isolated user-data-dir: the verifier WRITES config (it picks a preset to prove
  // it changes settings), so it must never touch the user's real aria-config.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-perf-panel-'));
  const child = spawn(electron, ['--no-sandbox', `--user-data-dir=${dataDir}`, path.join(__dirname, '..', 'dist', 'main', 'index.js')], {
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_VERIFY_PERF: '1' },
  });
  const cleanup = () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} };

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
    cleanup();
    let p = {};
    try { p = JSON.parse(marks['perf-panel'] || '{}'); } catch (e) {}
    const isMs = (s) => typeof s === 'string' && /^\d+(\.\d+)?\s*(ms|s)$/.test(s.trim());

    const checks = [
      ['panel reported back', !!marks['perf-panel']],
      // A typed turn has no audio stage -> STT shows the em-dash placeholder.
      ['STT row is "—" for a text turn', p.stt === '—'],
      // The headline "time to first audio" + LLM + total show real durations.
      ['first-audio row shows a duration', isMs(p.firstAudio)],
      ['LLM row shows a duration', isMs(p.llm)],
      ['Total row shows a duration', isMs(p.total)],
      // Voice turn: "time to first audio" + "full reply" must be measured from
      // END of speech, so a 200ms utterance with a ~100ms post-speech path reads
      // ~100ms — NOT ~300ms (the old audio_start bug counted the speaking time).
      ['voice time-to-first-audio excludes speaking time',
        typeof p.voiceFirstAudio === 'number' && p.voiceFirstAudio < 200],
      ['voice full-reply excludes speaking time',
        typeof p.voiceTotal === 'number' && p.voiceTotal < 200],
      ['LLM label names the target', typeof p.llmLabel === 'string' && /LLM/.test(p.llmLabel)],
      // Hardware line is populated by the real hardware:info IPC round-trip.
      ['hardware line populated', typeof p.hw === 'string' && /tier/.test(p.hw) && /GPU:/.test(p.hw)],
      ['resource preset control set', ['auto', 'power-saver', 'balanced', 'max-performance', 'custom'].includes(String(p.perfPreset || ''))],
      // Picking "power-saver" must REALLY change the STT model + voice (the core
      // P0 complaint: presets that did nothing).
      ['preset applied -> STT model = tiny.en', p.psSttModel === 'tiny.en'],
      ['preset applied -> Piper voice', p.psTtsVoice === 'en_US-lessac-medium'],
      ['preset dropdown reflects power-saver', p.psPreset === 'power-saver'],
      // Hand-editing a managed setting flips the preset to custom.
      ['manual STT edit -> preset becomes custom', p.customPreset === 'custom'],
      // Updates panel populated via the update:current IPC round-trip.
      ['update version shows a semver', /^\d+\.\d+\.\d+/.test(String(p.updVersion || ''))],
      ['update channel hint populated', typeof p.updHint === 'string' && p.updHint.length > 10],
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
