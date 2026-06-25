// Wrapped in an IIFE: top-level `const`s here (aria, etc.) must NOT be global
// lexical bindings — contextBridge exposes `aria` as a non-configurable global
// property, and a global-scope `const aria` collides with it (SyntaxError:
// "Identifier 'aria' has already been declared"). Function scope avoids that.
(function () {
'use strict';
const { aria } = window;

// Apply a theme by id; refresh the orb so it picks up the new accent.
function applyTheme(id) {
  document.documentElement.dataset.theme = id || 'midnight';
  if (window.AriaOrb && window.AriaOrb.refreshAccent) window.AriaOrb.refreshAccent();
}
// Apply the saved theme as early as possible to avoid a flash.
(async () => {
  try { applyTheme((await aria.config.get('ui.theme')) || 'midnight'); } catch (e) {}
})();

const conversationEl = document.getElementById('conversation');
const partialEl = document.getElementById('partial');
const textInput = document.getElementById('text-input');
const micBtn = document.getElementById('mic-btn');
const errorBanner = document.getElementById('error-banner');
const statusDots = {
  stt: document.getElementById('status-stt'),
  tts: document.getElementById('status-tts'),
  wakeword: document.getElementById('status-wakeword'),
};

let listening = false;
let currentAssistantMsg = null;

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.textContent = text;
  conversationEl.appendChild(div);
  conversationEl.scrollTop = conversationEl.scrollHeight;
  return div;
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.add('visible');
  setTimeout(() => errorBanner.classList.remove('visible'), 8000);
}

// Error boundary: surface uncaught renderer errors to the user rather than
// failing silently (a silent failure is exactly how the early contextBridge
// bug stayed hidden).
window.addEventListener('error', (e) => {
  showError(`Internal error: ${e.message}`);
});
window.addEventListener('unhandledrejection', (e) => {
  showError(`Internal error: ${e.reason && e.reason.message ? e.reason.message : e.reason}`);
});

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && textInput.value.trim()) {
    const text = textInput.value.trim();
    textInput.value = '';
    addMessage('user', text);
    orbState('processing');
    aria.llm.send(text);
  }
});

// --- Microphone capture ---
// A single persistent getUserMedia stream feeds an AudioWorklet. Every frame is
// downsampled to 16kHz int16 and sent to main, which routes it to the always-on
// wake-word sidecar (and to STT while an utterance is active). Push-to-talk and
// wake-word detection both open an STT utterance.
let micStarted = false;

async function startMicCapture() {
  if (micStarted) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('mic-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'mic-capture');

    worklet.port.onmessage = (e) => {
      const { samples, rate } = e.data;
      const pcm = window.AriaAudio.micFrameToPcm16k(samples, rate);
      aria.mic.sendAudio(pcm);
      if (vadActive) updateVad(samples);
    };

    source.connect(worklet);
    // Keep the graph alive without audible output.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    worklet.connect(sink).connect(ctx.destination);

    micStarted = true;
  } catch (err) {
    showError(`Microphone unavailable: ${err.message}. Use text input instead.`);
  }
}

// Energy-based endpointing for hands-free (wake-word) utterances: after ~800ms
// of silence (once speech has been seen) the utterance ends. Logic lives in the
// shared, unit-tested VadEndpointer; here we just drive it and cap the duration.
let vadActive = false;
let vad = null;
let vadSafetyTimer = null;

function updateVad(samples) {
  if (vad && vad.pushFrame(samples)) endUtterance();
}

// Drive the orb's visual state through the conversation pipeline.
function orbState(s) { if (window.AriaOrb) window.AriaOrb.setState(s); }

function beginUtterance(opts) {
  listening = true;
  micBtn.classList.add('listening');
  orbState('listening');
  aria.stt.start();
  // VAD endpointing only for hands-free (wake-word) turns; push-to-talk ends on
  // button release.
  vadActive = !!(opts && opts.vad);
  vad = vadActive ? new window.AriaAudio.VadEndpointer({ frameMs: 20 }) : null;
  clearTimeout(vadSafetyTimer);
  if (vadActive) vadSafetyTimer = setTimeout(endUtterance, 8000); // hard cap
}

function endUtterance() {
  if (!listening) return;
  listening = false;
  vadActive = false;
  vad = null;
  clearTimeout(vadSafetyTimer);
  micBtn.classList.remove('listening');
  orbState('processing'); // STT + LLM working
  aria.stt.end();
}

micBtn.addEventListener('mousedown', beginUtterance);
micBtn.addEventListener('mouseup', endUtterance);
micBtn.addEventListener('mouseleave', endUtterance);

// Start capturing as soon as we have a user gesture (autoplay policy) or load.
startMicCapture();

aria.stt.onResult((text) => {
  if (text.trim()) {
    partialEl.textContent = '';
    addMessage('user', text);
    orbState('processing'); // STT done, LLM thinking
    aria.llm.send(text);
  } else {
    orbState('idle'); // nothing recognized
  }
});

aria.stt.onPartial((text) => {
  partialEl.textContent = text;
});

// Ctrl+Shift+F toggles the live FPS counter on the orb.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f' && window.AriaOrb) {
    window.AriaOrb.toggleFps();
  }
});

// Which target (LLM vs Agent harness) the coordinator routed to.
let pendingRoute = null;
aria.llm.onRoute((info) => { pendingRoute = info; });

aria.llm.onToken((token) => {
  if (!currentAssistantMsg) {
    currentAssistantMsg = addMessage('assistant', '');
    if (pendingRoute) {
      const badge = document.createElement('span');
      badge.className = 'route-badge route-' + pendingRoute.target;
      badge.textContent = pendingRoute.name;
      currentAssistantMsg.prepend(badge);
      pendingRoute = null;
    }
  }
  currentAssistantMsg.appendChild(document.createTextNode(token));
  conversationEl.scrollTop = conversationEl.scrollHeight;
});

aria.llm.onDone((fullText) => {
  // Streaming already populated the message text (preserving the route badge);
  // only fill in if nothing streamed (e.g. non-streaming reply).
  if (currentAssistantMsg && !currentAssistantMsg.textContent.trim()) {
    currentAssistantMsg.appendChild(document.createTextNode(fullText));
  }
  currentAssistantMsg = null;
  pendingRoute = null;
  orbState('speaking'); // agent is about to talk -> dynamic motion
  aria.tts.play(fullText);
});

// --- TTS PCM playback via Web Audio (gapless sentence-chunk scheduling) ---
// Piper emits 22050 Hz, 16-bit mono PCM. We schedule each chunk back-to-back
// so sentence chunks play seamlessly as they stream in.
const TTS_SAMPLE_RATE = 22050;
let audioCtx = null;
let nextPlayTime = 0;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
    // Analyser between playback and output drives the reactive orb.
    ttsAnalyser = audioCtx.createAnalyser();
    ttsAnalyser.fftSize = 1024;
    ttsAnalyser.smoothingTimeConstant = 0.6;
    ttsAnalyser.connect(audioCtx.destination);
    pollTtsLevel();
  }
  return audioCtx;
}

let ttsAnalyser = null;
const _analyserBuf = new Float32Array(1024);

// Continuously sample the TTS analyser and feed the orb. Cheap; runs via rAF.
function pollTtsLevel() {
  if (ttsAnalyser && window.AriaOrb) {
    ttsAnalyser.getFloatTimeDomainData(_analyserBuf);
    let sum = 0;
    for (let i = 0; i < _analyserBuf.length; i++) sum += _analyserBuf[i] * _analyserBuf[i];
    const rms = Math.sqrt(sum / _analyserBuf.length);
    // Map speech RMS (~0..0.3) into a lively 0..1 orb level.
    window.AriaOrb.setLevel(Math.min(1, rms * 3.2));
  }
  requestAnimationFrame(pollTtsLevel);
}

aria.tts.onAudio((pcmArrayBuffer) => {
  const ctx = getAudioCtx();
  const int16 = new Int16Array(pcmArrayBuffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  const buffer = ctx.createBuffer(1, float32.length, TTS_SAMPLE_RATE);
  buffer.getChannelData(0).set(float32);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ttsAnalyser);

  const now = ctx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
});

aria.tts.onState((state) => {
  if (state && state.state === 'done') {
    // Return to idle once the remaining buffered audio finishes playing.
    const remainMs = audioCtx ? Math.max(0, (nextPlayTime - audioCtx.currentTime) * 1000) : 0;
    setTimeout(() => orbState('idle'), remainMs + 150);
    nextPlayTime = 0;
  }
});

aria.llm.onError((error) => {
  currentAssistantMsg = null;
  orbState('idle');
  showError(`LLM error: ${error}. Text input remains available.`);
});

aria.wakeword.onDetected((phrase) => {
  // Wake word heard -> open a hands-free STT utterance with VAD endpointing:
  // it ends automatically after ~800ms of silence (or the 8s safety cap).
  beginUtterance({ vad: true });
});

aria.sidecar.onStatus(({ name, status, detail }) => {
  const dot = statusDots[name];
  if (!dot) return;

  dot.className = 'status-dot';
  if (status === 'ready' || status === 'started') dot.classList.add('active');
  else if (status === 'error' || status === 'circuit-open') dot.classList.add('error');
  else if (status === 'restarting') dot.classList.add('loading');
});

aria.sidecar.onError(({ name, status, detail }) => {
  showError(`${name}: ${detail || status}`);
});

(async () => {
  const { backend, safe } = await aria.secure.getBackend();
  if (!safe) {
    showError(
      `Security warning: secret storage backend is "${backend}". ` +
      'API keys will not be securely stored. Install gnome-keyring for secure storage.'
    );
  }
})();

// --- Settings panel ---
const settingsOverlay = document.getElementById('settings-overlay');
const settingsBtn = document.getElementById('settings-btn');
const settingsClose = document.getElementById('settings-close');
const settingsSave = document.getElementById('settings-save');
const savedMsg = document.getElementById('settings-saved-msg');
const secureWarning = document.getElementById('secure-warning');

const cfg = {
  routingMode: document.getElementById('cfg-routing-mode'),
  llmEndpoint: document.getElementById('cfg-llm-endpoint'),
  llmModel: document.getElementById('cfg-llm-model'),
  llmKey: document.getElementById('cfg-llm-key'),
  harness: document.getElementById('cfg-harness'),
  harnessEndpoint: document.getElementById('cfg-harness-endpoint'),
  harnessModel: document.getElementById('cfg-harness-model'),
  harnessKey: document.getElementById('cfg-harness-key'),
  harnessNote: document.getElementById('cfg-harness-note'),
  sttModel: document.getElementById('cfg-stt-model'),
  sttBackend: document.getElementById('cfg-stt-backend'),
  ttsVoice: document.getElementById('cfg-tts-voice'),
  wwEnabled: document.getElementById('cfg-ww-enabled'),
  wwPhrase: document.getElementById('cfg-ww-phrase'),
  theme: document.getElementById('cfg-theme'),
};

// Live theme preview while the dropdown changes (persisted on Save).
cfg.theme.addEventListener('change', () => applyTheme(cfg.theme.value));

// Populate the harness dropdown once.
for (const h of window.AriaHarnesses.HARNESSES) {
  const opt = document.createElement('option');
  opt.value = h.id;
  opt.textContent = h.name;
  cfg.harness.appendChild(opt);
}

// Pick a harness preset -> prefill its endpoint/model + note (all editable).
function applyHarnessSelection(id, opts) {
  const h = window.AriaHarnesses.byId(id) || window.AriaHarnesses.byId('custom');
  cfg.harnessNote.textContent = h.note || '';
  if (opts && opts.prefill) {
    if (h.endpoint) cfg.harnessEndpoint.value = h.endpoint;
    if (h.defaultModel) cfg.harnessModel.value = h.defaultModel;
  }
}
cfg.harness.addEventListener('change', () => applyHarnessSelection(cfg.harness.value, { prefill: true }));

async function loadSettings() {
  cfg.routingMode.value = (await aria.config.get('routing.mode')) || 'auto';
  cfg.llmEndpoint.value = (await aria.config.get('llm.endpoint')) || '';
  cfg.llmModel.value = (await aria.config.get('llm.model')) || '';
  cfg.llmKey.value = '';
  cfg.harnessEndpoint.value = (await aria.config.get('harness.endpoint')) || '';
  cfg.harnessModel.value = (await aria.config.get('harness.model')) || '';
  cfg.harnessKey.value = '';
  const savedHarness = (await aria.config.get('harness.id')) || '';
  const inferred = savedHarness || (window.AriaHarnesses.fromEndpoint(cfg.harnessEndpoint.value) || {}).id || 'custom';
  cfg.harness.value = inferred;
  applyHarnessSelection(inferred, { prefill: false });
  cfg.sttModel.value = (await aria.config.get('stt.model')) || 'small';
  cfg.sttBackend.value = (await aria.config.get('stt.backend')) || 'vulkan';
  cfg.ttsVoice.value = (await aria.config.get('tts.voice')) || '';
  cfg.wwEnabled.checked = !!(await aria.config.get('wakeword.enabled'));
  cfg.wwPhrase.value = (await aria.config.get('wakeword.phrase')) || 'hey_jarvis';
  cfg.theme.value = (await aria.config.get('ui.theme')) || 'midnight';

  const { backend, safe } = await aria.secure.getBackend();
  if (!safe) {
    secureWarning.textContent =
      `Secret storage backend is "${backend}" — API keys are NOT securely encrypted. ` +
      'Install/unlock gnome-keyring for secure storage before saving a key.';
    secureWarning.classList.add('visible');
  } else {
    secureWarning.classList.remove('visible');
  }
}

function openSettings() {
  savedMsg.textContent = '';
  loadSettings();
  settingsOverlay.classList.add('visible');
}
async function closeSettings() {
  settingsOverlay.classList.remove('visible');
  // Revert any unsaved live theme preview to the persisted theme.
  applyTheme((await aria.config.get('ui.theme')) || 'midnight');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

settingsSave.addEventListener('click', async () => {
  await aria.config.set('routing.mode', cfg.routingMode.value);
  await aria.config.set('llm.endpoint', cfg.llmEndpoint.value.trim());
  await aria.config.set('llm.model', cfg.llmModel.value.trim());
  await aria.config.set('harness.id', cfg.harness.value);
  await aria.config.set('harness.endpoint', cfg.harnessEndpoint.value.trim());
  await aria.config.set('harness.model', cfg.harnessModel.value.trim());
  await aria.config.set('stt.model', cfg.sttModel.value);
  await aria.config.set('stt.backend', cfg.sttBackend.value);
  await aria.config.set('tts.voice', cfg.ttsVoice.value.trim());
  await aria.config.set('wakeword.enabled', cfg.wwEnabled.checked);
  await aria.config.set('wakeword.phrase', cfg.wwPhrase.value);
  await aria.config.set('ui.theme', cfg.theme.value);
  applyTheme(cfg.theme.value);

  // Write keys only if entered (blank keeps existing).
  if (cfg.llmKey.value.trim()) await aria.secure.set('llm-api-key', cfg.llmKey.value.trim());
  if (cfg.harnessKey.value.trim()) await aria.secure.set('harness-api-key', cfg.harnessKey.value.trim());

  savedMsg.textContent = 'Saved ✓';
  setTimeout(() => { savedMsg.textContent = ''; }, 2500);
});

// --- First-run onboarding walkthrough ---
const onb = {
  overlay: document.getElementById('onboard-overlay'),
  dots: document.getElementById('onboard-dots'),
  steps: Array.from(document.querySelectorAll('.onboard-step')),
  back: document.getElementById('onb-back'),
  skip: document.getElementById('onb-skip'),
  next: document.getElementById('onb-next'),
  harness: document.getElementById('onb-harness'),
  endpointRow: document.getElementById('onb-endpoint-row'),
  endpoint: document.getElementById('onb-endpoint'),
  note: document.getElementById('onb-note'),
  model: document.getElementById('onb-model'),
  keyDesc: document.getElementById('onb-key-desc'),
  key: document.getElementById('onb-key'),
  test: document.getElementById('onb-test'),
  testResult: document.getElementById('onb-test-result'),
  mic: document.getElementById('onb-mic'),
  micResult: document.getElementById('onb-mic-result'),
  wake: document.getElementById('onb-wake'),
};
let onbStep = 0;
const ONB_LAST = 4;

// Build step dots + provider dropdown
onb.steps.forEach(() => {
  const d = document.createElement('div');
  d.className = 'dot';
  onb.dots.appendChild(d);
});
for (const h of window.AriaHarnesses.HARNESSES) {
  const o = document.createElement('option');
  o.value = h.id; o.textContent = h.name;
  onb.harness.appendChild(o);
}

function onbSelectedHarness() {
  return window.AriaHarnesses.byId(onb.harness.value) || window.AriaHarnesses.byId('custom');
}
function onbApplyHarness() {
  const h = onbSelectedHarness();
  onb.endpointRow.style.display = ''; // editable for all — harnesses vary
  onb.note.textContent = h.note || '';
  if (h.endpoint) onb.endpoint.value = h.endpoint;
  if (h.defaultModel) onb.model.value = h.defaultModel;
  onb.key.placeholder = 'optional';
}
onb.harness.addEventListener('change', onbApplyHarness);

function onbResolveEndpoint() {
  return onb.endpoint.value.trim();
}

function onbRender() {
  onb.steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== onbStep; });
  Array.from(onb.dots.children).forEach((d, i) => {
    d.className = 'dot' + (i === onbStep ? ' active' : i < onbStep ? ' done' : '');
  });
  onb.back.style.visibility = onbStep === 0 ? 'hidden' : 'visible';
  onb.next.textContent = onbStep === ONB_LAST ? 'Finish' : 'Next';
}

let onbAdvanceDir = 1;
async function onbNext() {
  if (onbStep === ONB_LAST) return onbFinish();
  onbAdvanceDir = 1;
  onbStep = Math.min(ONB_LAST, onbStep + 1);
  onbRender();
}
function onbBack() {
  onbAdvanceDir = -1;
  onbStep = Math.max(0, onbStep - 1);
  onbRender();
}

onb.test.addEventListener('click', async () => {
  onb.test.disabled = true;
  onb.testResult.textContent = 'Testing…';
  onb.testResult.className = '';
  if (onb.key.value.trim()) await aria.secure.set('harness-api-key', onb.key.value.trim());
  const apiKey = await aria.secure.get('harness-api-key');
  const r = await aria.llm.test({ endpoint: onbResolveEndpoint(), model: onb.model.value.trim(), apiKey });
  if (r.ok) { onb.testResult.textContent = '✓ Connected'; onb.testResult.className = 'ok-msg'; }
  else { onb.testResult.textContent = '✕ ' + (r.error || 'failed'); onb.testResult.className = 'err-msg'; }
  onb.test.disabled = false;
});

onb.mic.addEventListener('click', async () => {
  onb.mic.disabled = true;
  await startMicCapture();
  if (micStarted) { onb.micResult.textContent = '✓ Microphone enabled'; onb.micResult.className = 'ok-msg'; }
  else { onb.micResult.textContent = '✕ Not granted — you can type instead'; onb.micResult.className = 'err-msg'; }
  onb.mic.disabled = false;
});

async function onbFinish() {
  // Onboarding configures the agent harness (the primary target). A separate
  // conversational LLM is optional, set later in Settings.
  await aria.config.set('harness.id', onb.harness.value);
  await aria.config.set('harness.endpoint', onbResolveEndpoint());
  await aria.config.set('harness.model', onb.model.value.trim());
  if (onb.key.value.trim()) await aria.secure.set('harness-api-key', onb.key.value.trim());
  await aria.config.set('ui.onboarded', true);
  onb.overlay.classList.remove('visible');
}

onb.next.addEventListener('click', onbNext);
onb.back.addEventListener('click', onbBack);
onb.skip.addEventListener('click', async () => {
  await aria.config.set('ui.onboarded', true);
  onb.overlay.classList.remove('visible');
});

(async () => {
  const onboarded = await aria.config.get('ui.onboarded');
  const phrase = (await aria.config.get('wakeword.phrase')) || 'hey_jarvis';
  onb.wake.textContent = '"' + phrase.replace(/_/g, ' ') + '"';
  if (!onboarded) {
    onbApplyHarness();
    onbStep = 0;
    onbRender();
    onb.overlay.classList.add('visible');
  }
})();
})();
