#!/usr/bin/env node
/* Unit test for hardware detection + the adaptive performance profile, and for
 * the renderer-side latency-timeline math (perf.js) that feeds the Settings →
 * Performance panel. No Electron/GPU needed: hardware.ts is pure Node, and perf.js
 * is loaded into a minimal window stub. */
const path = require('path');
const { detectHardware, perfProfile, clampCap } = require('../dist/main/hardware');

let pass = true;
function check(name, cond, detail) {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL' + (detail ? ' -> ' + detail : '')}`);
}

// ---- hardware.ts --------------------------------------------------------
const hw = detectHardware();
check('hw.cpuCores', hw.cpuCores >= 1, String(hw.cpuCores));
check('hw.totalMemGB', hw.totalMemGB > 0, String(hw.totalMemGB));
check('hw.tier', ['low', 'medium', 'high'].includes(hw.tier), hw.tier);
check('hw.gpu.name', typeof hw.gpu.name === 'string' && hw.gpu.name.length > 0, hw.gpu.name);
check('hw.gpu.vendor', ['amd', 'nvidia', 'intel', 'unknown'].includes(hw.gpu.vendor), hw.gpu.vendor);
check('hw.cached', detectHardware() === hw, 'detectHardware should cache the same object');

// clampCap bounds + invalid handling
check('clampCap.low', clampCap(5) === 20, String(clampCap(5)));
check('clampCap.high', clampCap(999) === 100, String(clampCap(999)));
check('clampCap.nan', clampCap('x') === 50, String(clampCap('x')));
check('clampCap.round', clampCap(49.6) === 50, String(clampCap(49.6)));

// Profile invariants across caps: lower cap -> never MORE GPU work than a higher cap.
const QORDER = ['low', 'medium', 'high'];
let prevThreads = -1, prevQ = -1;
for (const cap of [35, 50, 80, 100]) {
  const p = perfProfile(hw, cap);
  check(`profile.${cap}.threads>=1`, p.sttThreads >= 1 && p.sttThreads <= hw.cpuCores, String(p.sttThreads));
  check(`profile.${cap}.cap`, p.gpuCapPct === cap, String(p.gpuCapPct));
  check(`profile.${cap}.threads-monotonic`, p.sttThreads >= prevThreads, `${p.sttThreads} < ${prevThreads}`);
  const qi = QORDER.indexOf(p.orbQuality);
  check(`profile.${cap}.quality-monotonic`, qi >= prevQ, `${p.orbQuality} below previous`);
  prevThreads = p.sttThreads; prevQ = qi;
}
// A very low cap must keep STT off the GPU (so GPU stays near idle).
check('profile.35.cpu', perfProfile(hw, 35).sttBackend === 'cpu', perfProfile(hw, 35).sttBackend);

// ---- perf.js timeline math (renderer) ----------------------------------
// Minimal window so perf.js can install window.AriaPerf without Electron.
const fakeWindow = { aria: undefined };
global.window = fakeWindow;
global.performance = { now: () => Date.now() };
require(path.join(__dirname, '..', 'src', 'renderer', 'perf.js'));
const AriaPerf = fakeWindow.AriaPerf;
check('perf.installed', !!AriaPerf, 'window.AriaPerf missing');

// Simulate one voice turn's marks with controlled timestamps by monkeypatching
// performance.now between marks, then assert the derived per-stage durations.
const turn = AriaPerf.newTurn('voice');
let clock = 1000;
global.performance.now = () => clock;
function at(ms, fn) { clock = ms; fn(); }
at(1000, () => AriaPerf.mark(turn, 'audio_start'));
at(1500, () => AriaPerf.mark(turn, 'audio_end'));
at(1900, () => AriaPerf.mark(turn, 'stt_result_render')); // STT = 400ms
at(1950, () => AriaPerf.mark(turn, 'user_input'));
at(2000, () => AriaPerf.mark(turn, 'dispatch'));
at(2700, () => AriaPerf.mark(turn, 'first_token_render'));  // LLM = 700ms
at(2750, () => AriaPerf.mark(turn, 'tts_first_request'));
at(2900, () => AriaPerf.mark(turn, 'tts_first_audio'));     // TTS = 150ms
at(3600, () => AriaPerf.mark(turn, 'turn_complete'));        // total = audio_start..complete = 2600ms
AriaPerf.setTurnMeta(turn, { target: 'LLM' });

const s = AriaPerf.lastStages();
check('perf.stt', s && s.stt === 400, s && String(s.stt));
check('perf.llm', s && s.llm === 700, s && String(s.llm));
check('perf.tts', s && s.tts === 150, s && String(s.tts));
check('perf.total', s && s.total === 2600, s && String(s.total));
check('perf.target', s && s.target === 'LLM', s && String(s.target));

// A typed turn (no audio_*) -> STT is null but LLM/total still compute.
const t2 = AriaPerf.newTurn('text');
at(5000, () => AriaPerf.mark(t2, 'user_input'));
at(5010, () => AriaPerf.mark(t2, 'dispatch'));
at(5300, () => AriaPerf.mark(t2, 'first_token_render')); // LLM = 290ms
at(5400, () => AriaPerf.mark(t2, 'turn_complete'));        // total = 400ms
const s2 = AriaPerf.lastStages();
check('perf.text.stt-null', s2 && s2.stt === null, s2 && String(s2.stt));
check('perf.text.llm', s2 && s2.llm === 290, s2 && String(s2.llm));
check('perf.text.total', s2 && s2.total === 400, s2 && String(s2.total));

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
