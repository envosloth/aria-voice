#!/usr/bin/env node
/* Renderer contract for ARIA's state-controlled particle orb.
 *
 * The user-supplied GIF is retained as the source reference, but Chromium cannot
 * pause or seek an <img>-hosted GIF. The renderer therefore plays a transparent
 * WebM derived from the same frames: compact while idle/listening, expanding and
 * rippling only while processing, audio-reactive while speaking, then visibly
 * consolidating when speech ends.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const orb = fs.readFileSync(path.join(root, 'src', 'renderer', 'orb.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
const copier = fs.readFileSync(path.join(root, 'scripts', 'copy-renderer.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const smokeProfilePath = path.join(root, 'src', 'main', 'smoke-user-data.ts');
const smokeLauncherPath = path.join(root, 'scripts', 'smoke-electron.js');
const smokeProfile = fs.existsSync(smokeProfilePath) ? fs.readFileSync(smokeProfilePath, 'utf8') : '';
const smokeLauncher = fs.existsSync(smokeLauncherPath) ? fs.readFileSync(smokeLauncherPath, 'utf8') : '';
const assetsDir = path.join(root, 'src', 'renderer', 'assets');
const gifPath = path.join(assetsDir, 'aria-orb.gif');
const videoPath = path.join(assetsDir, 'aria-orb.webm');
const posterPath = path.join(assetsDir, 'aria-orb-compact.png');

let pass = true;
function check(name, condition, detail = '') {
  if (!condition) pass = false;
  console.log(`[${name}] ${condition ? 'PASS' : `FAIL${detail ? ` -> ${detail}` : ''}`}`);
}

check('asset.sourceGif.exists', fs.existsSync(gifPath), 'retain the supplied GIF as the animation source');
if (fs.existsSync(gifPath)) {
  const bytes = fs.readFileSync(gifPath);
  const header = bytes.subarray(0, 6).toString('ascii');
  let frameControls = 0;
  let allUseTransparentPaletteZero = true;
  for (let i = 0; i + 7 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
      frameControls++;
      if ((bytes[i + 3] & 1) !== 1 || bytes[i + 6] !== 0) allUseTransparentPaletteZero = false;
    }
  }
  check('asset.sourceGif.valid', header === 'GIF87a' || header === 'GIF89a', `unexpected header ${header}`);
  check('asset.sourceGif.transparent', frameControls === 450 && allUseTransparentPaletteZero,
    'every supplied animation frame must retain transparency');
}
check('asset.video.exists', fs.existsSync(videoPath), 'a seekable transparent video is required for state control');
if (fs.existsSync(videoPath)) {
  const bytes = fs.readFileSync(videoPath);
  const isWebm = bytes.length > 4
    && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  check('asset.video.webm', isWebm, 'the controllable animation must be a WebM container');
  const alphaIndex = bytes.indexOf(Buffer.from('ALPHA_MODE'));
  const alphaValue = Buffer.from([0x44, 0x87, 0x81, 0x31]); // EBML TagString "1"
  check('asset.video.alphaMetadata',
    alphaIndex >= 0 && bytes.subarray(alphaIndex, alphaIndex + 24).includes(alphaValue),
    'the WebM must advertise its encoded alpha plane');
  const durationIndex = bytes.indexOf(Buffer.from('DURATION'));
  check('asset.video.durationMetadata',
    durationIndex >= 0 && bytes.subarray(durationIndex, durationIndex + 40).includes(Buffer.from('00:00:09.')),
    'the controlled segment timings require the original nine-second duration');
  check('asset.video.nontrivial', bytes.length > 1_000_000 && bytes.length < 8_000_000,
    'the video was replaced with a thumbnail or an unnecessarily large transcode');
}
check('asset.poster.exists', fs.existsSync(posterPath), 'the compact idle frame must be available before video metadata loads');
if (fs.existsSync(posterPath)) {
  const bytes = fs.readFileSync(posterPath);
  const png = bytes.length > 8 && bytes.subarray(1, 4).toString('ascii') === 'PNG';
  check('asset.poster.png', png, 'the compact poster must be a PNG');
}

check('markup.controlledVideo',
  /<video id="orb-animation"[^>]*poster="assets\/aria-orb-compact\.png"[^>]*muted[^>]*playsinline[^>]*aria-hidden="true"/.test(html)
    && /<source src="assets\/aria-orb\.webm" type="video\/webm">/.test(html),
  'the visible orb must use the seekable rendering of the supplied animation');
check('markup.noUncontrolledPlayback',
  !/<video id="orb-animation"[^>]*\b(?:autoplay|loop)\b/.test(html),
  'idle/listening must not run the full animation loop');
check('markup.noCanvasOrb', !/id="orb-canvas"/.test(html), 'the retired canvas must not remain in the UI');
check('renderer.noObsoleteFpsDiagnostics',
  !/Ctrl\+Shift\+F toggles the live FPS counter/.test(app)
    && !/function (?:benchmark|measure|pump|toggleFps)\(/.test(orb)
    && !/AriaOrb\.(?:benchmark|measure|pump|toggleFps)\(/.test(main),
  'the video adapter must not advertise retired canvas FPS diagnostics');
check('styles.stateFeedback',
  /body\[data-state="listening"\]\s+#orb-animation/.test(html)
    && /body\[data-state="processing"\]\s+#orb-animation/.test(html)
    && /body\[data-state="speaking"\]\s+#orb-animation/.test(html),
  'voice states must continue to have distinct visible feedback');
check('styles.audioReactive',
  /--orb-brightness/.test(html) && /--orb-shadow-blur/.test(html) && !/orb-speaking-pulse/.test(html),
  'speaking motion must come from the live TTS envelope rather than a fixed pulse');
check('styles.lightTheme', /html\[data-theme="light"\]\s+#orb-animation/.test(html),
  'the transparent asset needs a high-contrast light-theme treatment too');
check('styles.transparentRendering', /#orb-animation\s*\{[^}]*mix-blend-mode:\s*normal/.test(html),
  'the transparent animation must render normally rather than rely on a black-background blend hack');
check('renderer.noCanvasLoop',
  !/getContext\(['"]2d/.test(orb) && !/requestAnimationFrame/.test(orb) && !/setInterval/.test(orb),
  'the replacement must not recreate an always-on GPU render loop');
check('renderer.phaseControl',
  /THINK_LOOP_START_SECONDS/.test(orb)
    && /THINK_LOOP_END_SECONDS/.test(orb)
    && /CONSOLIDATE_START_SECONDS/.test(orb)
    && /addEventListener\(['"]timeupdate/.test(orb)
    && /addEventListener\(['"]ended/.test(orb),
  'the adapter must control thinking and consolidation segments explicitly');
check('renderer.stateAdapter',
  /function setState\(next\)/.test(orb)
    && /function setLevel\(value\)/.test(orb)
    && /root\.AriaOrb\s*=/.test(orb),
  'app.js must retain its state and audio-level bridge');
check('renderer.sttSafe',
  /function beginSttCompute\(\)/.test(orb)
    && /function endSttCompute\(\)/.test(orb)
    && /function setSttBackend\(backend\)/.test(orb),
  'the existing Vulkan STT quiesce lifecycle must remain intact');
check('capture.isolatesUserDataBeforeConfig',
  /^import ['"]\.\/smoke-user-data['"];/.test(main)
    && /app\.setPath\(['"]userData['"]/.test(smokeProfile)
    && main.indexOf("import './smoke-user-data';") < main.indexOf("import { config } from './config';"),
  'smoke userData must be selected before persistent stores are imported');
check('capture.launcherUsesDisposableProfile',
  /mkdtempSync/.test(smokeLauncher)
    && /ARIA_SMOKE_USER_DATA/.test(smokeLauncher)
    && /rmSync\([^\n]*recursive:\s*true/.test(smokeLauncher)
    && packageJson.scripts['smoke:boot'] === 'npm run build && node scripts/smoke-electron.js',
  'the official Electron smoke launcher must create and remove a disposable profile');
check('capture.doesNotPersistOnboarding',
  !/config\.set\(['"]ui\.onboarded['"],\s*true\)/.test(main),
  'visual setup must dismiss overlays in the DOM without changing persisted onboarding');
check('capture.verifiesRequestedState',
  /AriaOrb\.getState\(\)[\s\S]*document\.body\.dataset\.state[\s\S]*video\.dataset\.phase/.test(main)
    && /orb state verified/.test(main),
  'a PNG alone must not count as proof that the requested state rendered');
check('capture.failClosed',
  /screenshot failed:[^\n]*[\s\S]*smokeFailed\s*=\s*true/.test(main)
    && /app\.exit\(smokeFailed\s*\?\s*1\s*:\s*0\)/.test(main),
  'invalid state, seek, or capture failures must return a non-zero exit');
check('build.copiesRuntimeAssets',
  /const assets = \[[\s\S]*aria-orb\.webm[\s\S]*aria-orb-compact\.png/.test(copier)
    && /fs\.rmSync\([^\n]*outAssetsDir/.test(copier),
  'the build must copy only runtime orb media and remove stale packaged source assets');

// Exercise the real state adapter with a minimal video-shaped DOM. This checks
// behavior rather than merely confirming that method names exist in source.
const properties = new Map();
const listeners = new Map();
let playCalls = 0;
let pauseCalls = 0;
const playRejections = [];
const video = {
  dataset: {},
  hidden: false,
  style: { setProperty: (name, value) => properties.set(name, value) },
  currentTime: 0,
  playbackRate: 1,
  duration: 9,
  readyState: 4,
  paused: true,
  play() {
    playCalls++;
    this.paused = false;
    return { catch(callback) { playRejections.push(callback); } };
  },
  pause() { pauseCalls++; this.paused = true; },
  setAttribute: () => {},
  addEventListener(name, callback) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(callback);
  },
};
function emit(name) {
  for (const callback of listeners.get(name) || []) callback();
}

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
let nextTimerId = 0;
const scheduledTimers = new Map();
global.setTimeout = (callback, delay) => {
  const id = ++nextTimerId;
  scheduledTimers.set(id, { callback, delay });
  return id;
};
global.clearTimeout = (id) => scheduledTimers.delete(id);
global.window = {};
global.self = global.window;
global.document = {
  readyState: 'complete',
  body: { dataset: {} },
  getElementById: (id) => (id === 'orb-animation' ? video : null),
  addEventListener: () => {},
};
require(path.join(root, 'src', 'renderer', 'orb.js'));
const Orb = global.window.AriaOrb;

check('adapter.initializesCompact',
  !!Orb && Orb.getState() === 'idle' && video.dataset.state === 'idle'
    && video.dataset.phase === 'consolidated' && video.paused && video.currentTime === 0,
  'startup must show a paused, consolidated orb');

const playsBeforeThinking = playCalls;
Orb.setState('processing');
check('adapter.thinkingExpands',
  video.dataset.state === 'processing' && video.dataset.phase === 'thinking'
    && !video.paused && playCalls > playsBeforeThinking,
  'processing must play the expansion/ripple segment');
video.currentTime = 6.2;
emit('timeupdate');
check('adapter.thinkingLoopsRipple',
  video.currentTime >= 2.5 && video.currentTime <= 3.5 && !video.paused,
  'long thinking must loop the expanded ripple segment without consolidating');

video.currentTime = 4.4;
const playsBeforeSpeaking = playCalls;
const pausesBeforeSpeaking = pauseCalls;
Orb.setState('speaking');
const speakingBaseScale = Number(properties.get('--orb-scale-x'));
check('adapter.speakingHoldsParticles',
  video.dataset.phase === 'speaking' && video.paused && video.currentTime === 4.4
    && playCalls === playsBeforeSpeaking && pauseCalls > pausesBeforeSpeaking,
  'speaking must hold the reached dispersed frame');
Orb.setLevel(0.7);
check('adapter.speakingLevel',
  Orb.getLevel() === 0.7
    && properties.get('--orb-energy') === '0.700'
    && Number(properties.get('--orb-scale-x')) > speakingBaseScale
    && Number(properties.get('--orb-brightness')) > 1
    && video.paused,
  'the live TTS envelope must drive scale, light, and glow without restarting video playback');
const heldSpeakingFrame = video.currentTime;
video.currentTime = heldSpeakingFrame;
emit('timeupdate');
check('adapter.speakingFrameStaysHeld',
  video.currentTime === heldSpeakingFrame && video.paused && playCalls === playsBeforeSpeaking,
  'speaking time updates must not seek or resume the held frame');

const playsBeforeSpeakingToProcessing = playCalls;
Orb.setState('processing');
check('adapter.speakingToProcessingConsolidates',
  Orb.getState() === 'processing' && Orb.getPhase() === 'consolidating'
    && video.currentTime >= 5.5 && !video.paused && playCalls > playsBeforeSpeakingToProcessing,
  'a new turn submitted during speech must visibly consolidate before thinking');
emit('ended');
check('adapter.speakingToProcessingStartsThinking',
  Orb.getState() === 'processing' && Orb.getPhase() === 'thinking'
    && video.currentTime === 0 && !video.paused,
  'processing must begin only after the interrupted speech shape finishes returning');

video.currentTime = 4.4;
Orb.setState('speaking');

const playsBeforeConsolidation = playCalls;
Orb.setState('idle');
check('adapter.speechEndConsolidates',
  video.dataset.state === 'idle' && video.dataset.phase === 'consolidating'
    && video.currentTime >= 5.5 && !video.paused && playCalls > playsBeforeConsolidation,
  'leaving speech must play the return/consolidation segment');
emit('ended');
check('adapter.consolidationCompletes',
  video.dataset.phase === 'consolidated' && video.paused && video.currentTime === 0,
  'the orb must finish compact and still after consolidation');

// Conversation mode and barge-in can move directly from speaking to listening.
// That transition must preserve the user-requested return animation, then remain
// compact for the rest of listening; a duplicate listening update must not cancel it.
Orb.setState('speaking');
Orb.setState('listening');
check('adapter.speakingToListeningConsolidates',
  Orb.getState() === 'listening' && Orb.getPhase() === 'consolidating' && !video.paused,
  'follow-up listening must allow the just-finished speech shape to consolidate');
Orb.setState('listening');
check('adapter.listeningKeepsActiveTail',
  Orb.getState() === 'listening' && Orb.getPhase() === 'consolidating' && !video.paused,
  'a repeated listening update must not interrupt an active return segment');
emit('ended');
check('adapter.listeningFinishesCompact',
  Orb.getState() === 'listening' && Orb.getPhase() === 'consolidated'
    && video.paused && video.currentTime === 0,
  'after the brief post-speech tail, listening must remain paused and compact');

Orb.setState('processing');
Orb.setState('listening');
check('adapter.processingToListeningConsolidates',
  Orb.getState() === 'listening' && Orb.getPhase() === 'consolidating' && !video.paused,
  'cancelled or failed thinking must return the expanded particles before listening');
emit('ended');
check('adapter.processingToListeningFinishesCompact',
  Orb.getState() === 'listening' && Orb.getPhase() === 'consolidated'
    && video.paused && video.currentTime === 0,
  'processing-to-listening must also finish paused and compact');

Orb.setState('processing');
Orb.setSttBackend('cpu');
Orb.beginSttCompute();
check('adapter.compute.cpuUnfrozen', Orb.isComputeFrozen() === false && video.hidden === false,
  'CPU STT must not hide the orb');
Orb.setSttBackend('vulkan');
Orb.beginSttCompute();
const computeTimer = [...scheduledTimers.values()].find((timer) => timer.delay === 6000);
const interruptedPlayReject = playRejections[playRejections.length - 1];
if (interruptedPlayReject) interruptedPlayReject(new Error('play interrupted by intentional compute pause'));
check('adapter.compute.interruptedPlayKeepsPhase', Orb.getPhase() === 'thinking',
  'an intentional compute pause must not be mistaken for a playback failure');
check('adapter.compute.quiescesVisual',
  Orb.isComputeFrozen() === true && video.hidden === true && video.paused,
  'Vulkan STT must pause and remove the video from the compositor during compute');
check('adapter.compute.failsafeScheduled', !!computeTimer,
  'a lost STT result must not leave the orb quiesced indefinitely');
if (computeTimer) computeTimer.callback();
check('adapter.compute.failsafeRecovers',
  Orb.isComputeFrozen() === false && video.hidden === false && !video.paused,
  'the compute failsafe must restore active thinking playback');
Orb.beginSttCompute();
Orb.beginStt();
check('adapter.compute.newListenClearsStaleFreeze',
  Orb.isComputeFrozen() === false && video.hidden === false,
  'a subsequent listen must clear a stale compute freeze immediately');
Orb.endStt();

global.setTimeout = realSetTimeout;
global.clearTimeout = realClearTimeout;

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
