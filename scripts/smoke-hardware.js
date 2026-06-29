#!/usr/bin/env node
/* Unit test for hardware detection + the adaptive performance profile, and for
 * the renderer-side latency-timeline math (perf.js) that feeds the Settings →
 * Performance panel. No Electron/GPU needed: hardware.ts is pure Node, and perf.js
 * is loaded into a minimal window stub. */
const path = require('path');
const { detectHardware, perfProfile, clampCap, resolveProfile, isPerfPreset } = require('../dist/main/hardware');

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

// ---- resource presets (resolveProfile) ----------------------------------
const VALID_STT = ['tiny.en', 'base.en', 'small', 'medium'];
for (const preset of ['auto', 'power-saver', 'balanced', 'max-performance']) {
  const p = resolveProfile(preset, hw);
  check(`preset.${preset}.sttModel`, VALID_STT.includes(p.sttModel), p.sttModel);
  check(`preset.${preset}.ttsEngine`, ['piper', 'kokoro'].includes(p.ttsEngine), p.ttsEngine);
  check(`preset.${preset}.orb`, ['low', 'medium', 'high'].includes(p.orbQuality), p.orbQuality);
  check(`preset.${preset}.cap`, p.gpuCapPct >= 20 && p.gpuCapPct <= 100, String(p.gpuCapPct));
  check(`preset.${preset}.threads`, p.sttThreads >= 1 && p.sttThreads <= hw.cpuCores, String(p.sttThreads));
}
// Power saver is the lightest bundle; max-performance the heaviest — and they
// must be DISTINCT (the user's complaint was that presets changed nothing).
const ps = resolveProfile('power-saver', hw);
const mp = resolveProfile('max-performance', hw);
const auto = resolveProfile('auto', hw);
check('power-saver.cpu', ps.sttBackend === 'cpu', ps.sttBackend);
check('power-saver.piper', ps.ttsEngine === 'piper', ps.ttsEngine);
check('power-saver.tiny', ps.sttModel === 'tiny.en', ps.sttModel);
check('power-saver.orb-low', ps.orbQuality === 'low', ps.orbQuality);
check('power-saver.cap-low', ps.gpuCapPct <= 35, String(ps.gpuCapPct));
check('max.orb-high', mp.orbQuality === 'high', mp.orbQuality);
check('max.cap-100', mp.gpuCapPct === 100, String(mp.gpuCapPct));
check('presets-distinct', JSON.stringify(ps) !== JSON.stringify(mp) && JSON.stringify(ps) !== JSON.stringify(auto),
  'power-saver / max / auto must differ');
check('isPerfPreset', isPerfPreset('auto') && isPerfPreset('power-saver') && !isPerfPreset('nope') && !isPerfPreset(5),
  'preset type guard');

// Power saver ships a clear British male Piper voice (en_GB-alan-medium) so the
// lightweight CPU engine still sounds natural.
check('power-saver.voice-male', ps.ttsVoice === 'en_GB-alan-medium', ps.ttsVoice);

// The per-voice Piper download path is derived generically from the voice id
// (<group>/<lang>/<speaker>/<quality>/), not hardcoded to one voice.
const { buildManifest } = require('../dist/main/model-manager');
const piperManifest = buildManifest('tiny.en', 'en_GB-alan-medium', 'piper');
const alan = piperManifest.find((s) => s.id === 'tts:en_GB-alan-medium');
check('piper.manifest.voice', !!alan, JSON.stringify(piperManifest.map((s) => s.id)));
check('piper.url.path', alan && alan.url.endsWith('/en/en_GB/alan/medium/en_GB-alan-medium.onnx'), alan && alan.url);
const lessac = buildManifest('tiny.en', 'en_US-lessac-medium', 'piper').find((s) => s.id === 'tts:en_US-lessac-medium');
check('piper.url.generic', lessac && lessac.url.endsWith('/en/en_US/lessac/medium/en_US-lessac-medium.onnx'), lessac && lessac.url);

// Orb smoothness fix: a high-tier host on the default 'auto' preset must resolve
// to gpuCap 100 -> HIGH orb quality. The bug was that 'auto' was never applied at
// startup, so the DEFAULT cap (50) -> perfProfile -> MEDIUM orb (choppy) even on a
// capable GPU. Use a synthetic high-tier host so the assertion holds on any CI box.
const fakeHigh = {
  cpuCores: 16, cpuModel: 'Test CPU', totalMemGB: 32,
  gpu: { name: 'Radeon RX 9060 XT', vendor: 'amd', vramMB: 16384, discrete: true },
  tier: 'high', platform: 'linux',
};
const autoHigh = resolveProfile('auto', fakeHigh);
check('auto.high.cap-100', autoHigh.gpuCapPct === 100, String(autoHigh.gpuCapPct));
check('auto.high.orb-high', autoHigh.orbQuality === 'high', autoHigh.orbQuality);
check('auto.high.perfProfile-high', perfProfile(fakeHigh, autoHigh.gpuCapPct).orbQuality === 'high',
  perfProfile(fakeHigh, autoHigh.gpuCapPct).orbQuality);
// Document the bug the startup-apply fixes: the old default cap (50) capped a
// capable GPU to medium — which is exactly why 'auto' must be resolved at startup.
check('auto.high.default-cap-was-medium', perfProfile(fakeHigh, 50).orbQuality === 'medium',
  perfProfile(fakeHigh, 50).orbQuality);

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
// Full-turn total is timed from audio_END (1500), not audio_start: the seconds the
// user spends speaking are not latency (see perf.js stagesOf). total =
// turn_complete(3600) - audio_end(1500) = 2100.
check('perf.total', s && s.total === 2100, s && String(s.total));
// Time to first audible audio = tts_first_audio(2900) - audio_end(1500) = 1400.
check('perf.firstAudio', s && s.firstAudio === 1400, s && String(s.firstAudio));
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
// No tts_first_audio mark on this turn -> first-audio is null (not 0).
check('perf.text.firstAudio-null', s2 && s2.firstAudio === null, s2 && String(s2.firstAudio));

// Short/fast voice reply where LLM text finishes BEFORE the audio plays. Without a
// tts_done mark this used to report total(turn_complete) < firstAudio(tts_first_audio)
// — the impossible "first audio longer than full reply". (a) clamp guarantees
// total >= firstAudio; (b) when tts_done IS present, total is measured to it.
const t3 = AriaPerf.newTurn('voice');
at(6000, () => AriaPerf.mark(t3, 'audio_end'));
at(6100, () => AriaPerf.mark(t3, 'dispatch'));
at(6200, () => AriaPerf.mark(t3, 'first_token_render'));
at(6300, () => AriaPerf.mark(t3, 'turn_complete'));        // text done at +300
at(6500, () => AriaPerf.mark(t3, 'tts_first_audio'));      // audio STARTS at +500
const s3 = AriaPerf.lastStages();
check('perf.inv.firstAudio', s3 && s3.firstAudio === 500, s3 && String(s3.firstAudio));
check('perf.inv.no-inversion', s3 && s3.total >= s3.firstAudio, s3 && `total=${s3.total} firstAudio=${s3.firstAudio}`);
const t4 = AriaPerf.newTurn('voice');
at(7000, () => AriaPerf.mark(t4, 'audio_end'));
at(7100, () => AriaPerf.mark(t4, 'dispatch'));
at(7200, () => AriaPerf.mark(t4, 'first_token_render'));
at(7300, () => AriaPerf.mark(t4, 'turn_complete'));
at(7500, () => AriaPerf.mark(t4, 'tts_first_audio'));
at(8200, () => AriaPerf.mark(t4, 'tts_done'));             // audio finishes at +1200
const s4 = AriaPerf.lastStages();
check('perf.ttsdone.total', s4 && s4.total === 1200, s4 && String(s4.total)); // to tts_done, not turn_complete(300)

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
