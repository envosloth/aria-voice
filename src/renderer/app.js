// Wrapped in an IIFE: top-level `const`s here (aria, etc.) must NOT be global
// lexical bindings — contextBridge exposes `aria` as a non-configurable global
// property, and a global-scope `const aria` collides with it (SyntaxError:
// "Identifier 'aria' has already been declared"). Function scope avoids that.
(function () {
'use strict';
const { aria } = window;

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

function beginUtterance(opts) {
  listening = true;
  micBtn.classList.add('listening');
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
    aria.llm.send(text);
  }
});

aria.stt.onPartial((text) => {
  partialEl.textContent = text;
});

aria.llm.onToken((token) => {
  if (!currentAssistantMsg) {
    currentAssistantMsg = addMessage('assistant', '');
  }
  currentAssistantMsg.textContent += token;
  conversationEl.scrollTop = conversationEl.scrollHeight;
});

aria.llm.onDone((fullText) => {
  if (currentAssistantMsg) {
    currentAssistantMsg.textContent = fullText;
  }
  currentAssistantMsg = null;
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
  }
  return audioCtx;
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
  source.connect(ctx.destination);

  const now = ctx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
});

aria.tts.onState((state) => {
  if (state && state.state === 'done') {
    nextPlayTime = 0;
  }
});

aria.llm.onError((error) => {
  currentAssistantMsg = null;
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
  endpoint: document.getElementById('cfg-llm-endpoint'),
  model: document.getElementById('cfg-llm-model'),
  key: document.getElementById('cfg-llm-key'),
  sttModel: document.getElementById('cfg-stt-model'),
  sttBackend: document.getElementById('cfg-stt-backend'),
  ttsVoice: document.getElementById('cfg-tts-voice'),
  wwEnabled: document.getElementById('cfg-ww-enabled'),
  wwPhrase: document.getElementById('cfg-ww-phrase'),
};

async function loadSettings() {
  cfg.endpoint.value = (await aria.config.get('llm.endpoint')) || '';
  cfg.model.value = (await aria.config.get('llm.model')) || '';
  cfg.sttModel.value = (await aria.config.get('stt.model')) || 'small';
  cfg.sttBackend.value = (await aria.config.get('stt.backend')) || 'vulkan';
  cfg.ttsVoice.value = (await aria.config.get('tts.voice')) || '';
  cfg.wwEnabled.checked = !!(await aria.config.get('wakeword.enabled'));
  cfg.wwPhrase.value = (await aria.config.get('wakeword.phrase')) || 'hey_jarvis';
  cfg.key.value = '';

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
function closeSettings() {
  settingsOverlay.classList.remove('visible');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

settingsSave.addEventListener('click', async () => {
  await aria.config.set('llm.endpoint', cfg.endpoint.value.trim());
  await aria.config.set('llm.model', cfg.model.value.trim());
  await aria.config.set('stt.model', cfg.sttModel.value);
  await aria.config.set('stt.backend', cfg.sttBackend.value);
  await aria.config.set('tts.voice', cfg.ttsVoice.value.trim());
  await aria.config.set('wakeword.enabled', cfg.wwEnabled.checked);
  await aria.config.set('wakeword.phrase', cfg.wwPhrase.value);

  // Only write the API key if the user entered one (blank keeps existing).
  if (cfg.key.value.trim()) {
    await aria.secure.set('llm-api-key', cfg.key.value.trim());
  }

  savedMsg.textContent = 'Saved ✓';
  setTimeout(() => { savedMsg.textContent = ''; }, 2500);
});
})();
