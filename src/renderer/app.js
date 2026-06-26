// Wrapped in an IIFE: top-level `const`s here (aria, etc.) must NOT be global
// lexical bindings — contextBridge exposes `aria` as a non-configurable global
// property, and a global-scope `const aria` collides with it (SyntaxError:
// "Identifier 'aria' has already been declared"). Function scope avoids that.
(function () {
'use strict';
const { aria } = window;

// Latency harness (see perf.js / src/main/perf.ts). Safe no-op stub if perf.js
// didn't load, so instrumenting the hot path never risks a ReferenceError.
const perf = window.AriaPerf || { newTurn: () => '', mark: () => {}, isEnabled: () => false };
// Correlation id for the in-flight turn, shared with main over IPC. Voice turns
// keep their id from audio_start through TTS playback so STT/LLM/TTS stages line
// up in one timeline.
let currentTurnId = null;
let currentVoiceTurnId = null;
// Per-turn "first occurrence" guards so each stage is marked once per turn.
let firstTokenRenderMarked = false;
let ttsFirstRequestMarked = false;
let ttsFirstAudioMarked = false;
function resetTurnMarkers() {
  firstTokenRenderMarked = false;
  ttsFirstRequestMarked = false;
  ttsFirstAudioMarked = false;
}

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

// When true, incoming TTS PCM is dropped on arrival. Set by stopPlayback() so
// the tail of an interrupted reply (already in flight from the sidecar) never
// reaches the speakers after a barge-in. Re-armed by ttsPlay() the instant we
// intentionally ask for new speech.
let ttsMuted = false;

// Single funnel for every "speak this text" request. Strips markdown, links,
// code, emoji and stray symbols so the voice never reads "asterisk" or spells
// out a URL (the on-screen transcript keeps the original text). Marks audio as
// wanted again so the onAudio gate lets the freshly-synthesized PCM through.
function ttsPlay(text) {
  const speakable = window.AriaAudio.sanitizeForSpeech(text);
  if (!speakable) return; // nothing worth speaking (e.g. a chunk that was just a URL)
  ttsMuted = false;
  try { aria.tts.play(speakable); } catch (e) {}
}

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

function assistantSay(text) {
  addMessage('assistant', text);
  try { stopPlayback(true); ttsPlay(text); orbState('speaking'); } catch (e) {}
}

// Speak without adding a transcript line (used for the "hold on" filler).
function speakOnly(text) {
  try { stopPlayback(true); ttsPlay(text); orbState('speaking'); } catch (e) {}
}

// Single entry point for user turns (text box + voice). Handles screen-share
// voice/text commands locally, and attaches the current desktop frame when
// screen sharing is active so the agent can see what the user is doing.
async function submitUserMessage(rawText, existingTurnId) {
  const text = (rawText || '').trim();
  if (!text) return;
  // A voice turn passes its existing id so STT->LLM->TTS stay one timeline; a
  // typed turn starts a fresh one.
  const turnId = existingTurnId || perf.newTurn('text');
  currentTurnId = turnId;
  resetTurnMarkers();
  perf.mark(turnId, 'user_input', { chars: text.length });
  addMessage('user', text);
  if (await handleScreenCommand(text)) return;
  orbState('processing');
  const image = shouldAttachScreen(text) ? await captureScreenFrame() : null;
  perf.mark(turnId, 'dispatch', image ? { image: 1 } : undefined);
  aria.llm.send(text, image, turnId);
  armThinkingHold(text);
}

// If a reply is slow (agent tasks can take a while), speak a short, contextual
// "hold on" so the user isn't left in silence. Cancelled as soon as the first
// token arrives. Spoken only — not added to the transcript.
let thinkingTimer = null;
let awaitingFirstToken = false;

function holdOnPhrase(text) {
  const t = text.toLowerCase();
  if (/\b(weather|forecast|temperature|rain)/.test(t)) return 'Let me check the weather for you — one moment.';
  if (/\b(news|headline|stock|price|score)/.test(t)) return 'Let me pull that up for you, just a sec.';
  if (/\b(search|look up|find|google|browse)/.test(t)) return 'Let me look that up for you.';
  if (/\b(code|build|run|fix|debug|file|deploy|install|commit|refactor|test)/.test(t)) return 'Working on that now — give me a moment.';
  if (/\bscreen\b|\bsee\b|\blook at\b/.test(t)) return 'Let me take a look — one moment.';
  if (t.trim().endsWith('?')) return 'Good question — let me think about that for a second.';
  return 'One moment, let me get that for you.';
}

function armThinkingHold(text) {
  clearTimeout(thinkingTimer);
  awaitingFirstToken = true;
  const phrase = holdOnPhrase(text);
  thinkingTimer = setTimeout(() => {
    if (awaitingFirstToken) speakOnly(phrase);
  }, 3800);
}

function cancelThinkingHold() {
  awaitingFirstToken = false;
  clearTimeout(thinkingTimer);
  thinkingTimer = null;
}

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && textInput.value.trim()) {
    const text = textInput.value.trim();
    textInput.value = '';
    submitUserMessage(text);
  }
});

// --- Screen share: feed the live desktop to the agent as vision context ---
let screenStream = null, screenTrack = null, screenGrabber = null, screenVideo = null;
// Most-recent frame, refreshed in the background so a message send never blocks
// on a capture (the "slow response in screen-share mode" fix).
let screenFrameCache = null, screenFrameTimer = null;
const screenCanvas = document.createElement('canvas');
const screenShareBtn = document.getElementById('screen-btn');

function isSharing() { return !!screenStream; }

async function startScreenShare() {
  if (screenStream) return true;
  try {
    // Low frame rate + capped width: we only need an occasional still for the
    // agent, so a continuous high-res decode (the old approach) just caused jank.
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 1, max: 2 }, width: { max: 1280 } },
      audio: false,
    });
    screenTrack = screenStream.getVideoTracks()[0];
    // Prefer ImageCapture: grabs a single frame on demand with no playing <video>
    // element continuously decoding in the background.
    screenGrabber = (typeof ImageCapture !== 'undefined') ? new ImageCapture(screenTrack) : null;
    if (!screenGrabber) {
      // Fallback for engines without ImageCapture: a muted off-DOM video.
      screenVideo = document.createElement('video');
      screenVideo.srcObject = screenStream;
      screenVideo.muted = true;
      await screenVideo.play();
    }
    screenTrack.addEventListener('ended', () => { stopScreenShare(); assistantSay('Screen sharing stopped.'); });
    if (screenShareBtn) screenShareBtn.classList.add('active');
    // Warm a frame now and keep it fresh in the background, off the send path.
    screenFrameCache = null;
    refreshScreenFrame();
    screenFrameTimer = setInterval(refreshScreenFrame, 1500);
    assistantSay('Screen sharing is on — I can see your screen now.');
    return true;
  } catch (err) {
    screenStream = null;
    showError(`Screen share unavailable: ${err.message}. You can still type or talk.`);
    return false;
  }
}

function stopScreenShare() {
  if (screenFrameTimer) { clearInterval(screenFrameTimer); screenFrameTimer = null; }
  screenFrameCache = null;
  if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null; screenTrack = null; screenGrabber = null; screenVideo = null;
  if (screenShareBtn) screenShareBtn.classList.remove('active');
}

// Grab one desktop frame as a downscaled JPEG data URL (small + fast). Async:
// ImageCapture.grabFrame() resolves an ImageBitmap we draw once. Downscaled to
// 768px @ 0.45 quality — still readable for the agent, but ~half the pixels of
// the old 1024px frame, which roughly halves the vision model's token/processing
// cost (the main lever on the "10+ seconds in screen-share mode" latency).
async function grabFrameDataUrl() {
  try {
    let srcW, srcH, drawable;
    if (screenGrabber) {
      const bmp = await screenGrabber.grabFrame();
      srcW = bmp.width; srcH = bmp.height; drawable = bmp;
    } else if (screenVideo && screenVideo.videoWidth) {
      srcW = screenVideo.videoWidth; srcH = screenVideo.videoHeight; drawable = screenVideo;
    } else { return null; }
    const maxW = 768;
    const scale = Math.min(1, maxW / srcW);
    const cw = Math.max(1, Math.round(srcW * scale));
    const ch = Math.max(1, Math.round(srcH * scale));
    screenCanvas.width = cw; screenCanvas.height = ch;
    screenCanvas.getContext('2d').drawImage(drawable, 0, 0, cw, ch);
    if (drawable.close) drawable.close(); // free the ImageBitmap
    return screenCanvas.toDataURL('image/jpeg', 0.45);
  } catch (e) {
    return null;
  }
}

// Background refresh: grab a frame and cache it. Best-effort — on failure the
// cache keeps its previous value rather than going blank.
async function refreshScreenFrame() {
  if (!isSharing()) return;
  const url = await grabFrameDataUrl();
  if (url) screenFrameCache = url;
}

// Send-path accessor: return the most recent cached frame instantly so the
// reply isn't blocked on a capture. Only if nothing is cached yet (a message
// fired the instant sharing started) do we grab directly, with a short timeout
// so a slow first capture can't stall the turn.
async function captureScreenFrame() {
  if (screenFrameCache) return screenFrameCache;
  const url = await Promise.race([
    grabFrameDataUrl(),
    new Promise((r) => setTimeout(() => r(null), 600)),
  ]);
  if (url) screenFrameCache = url;
  return url;
}

// While sharing, the desktop frame is attached so ARIA can see the screen — but
// some asks are plainly non-visual (weather, time, news, timers). Sending a
// screenshot with those forces the slow vision/agent path for no reason, which
// is what made EVERY turn take ~10s while sharing. Skip the frame for those;
// anything that might reference the screen still gets it.
//   - a strong visual reference always attaches (even over a non-visual keyword),
//   - a clearly non-visual ask skips,
//   - everything else defaults to attaching (sharing means "look at my screen").
const SCREEN_STRONG_RE = /\b(?:on (?:my|the) (?:screen|display|monitor)|what'?s on|screen|display|monitor|highlighted|selected|look at (?:this|that|the)|read (?:this|that|the)|see (?:this|that)|this (?:page|window|tab|error|code|screen|image|chart|graph))\b/i;
const SCREEN_NONVISUAL_RE = /\b(?:weather|forecast|temperature|umbrella|what time|time is it|what'?s the time|what day|what'?s the date|the news|headlines|stock price|set (?:a|an) (?:timer|alarm)|remind me|reminder|tell me a joke|how do you spell|define|translate)\b/i;
function shouldAttachScreen(text) {
  if (!isSharing()) return false;
  const t = (text || '').toLowerCase();
  if (SCREEN_STRONG_RE.test(t)) return true;     // explicit screen reference -> attach
  if (SCREEN_NONVISUAL_RE.test(t)) return false; // clearly non-visual -> stay on fast path
  return true;                                   // default while sharing: attach
}

async function toggleScreenShare() {
  if (isSharing()) { stopScreenShare(); assistantSay('Screen sharing stopped.'); }
  else { await startScreenShare(); }
}
if (screenShareBtn) screenShareBtn.addEventListener('click', toggleScreenShare);

// Natural-language control. OFF is checked first because "stop screen share"
// also matches the ON pattern.
const SCREEN_OFF_RE = /\b(stop|deactivate|disable|turn off|end)\b[^.!?]{0,24}\bscreen\b|\bstop sharing\b/i;
const SCREEN_ON_RE = /\b(start|activate|enable|turn on|begin|share)\b[^.!?]{0,24}\bscreen\b|\bshare (my |the )?screen\b|\bscreen[- ]?shar/i;
async function handleScreenCommand(text) {
  if (SCREEN_OFF_RE.test(text)) {
    if (isSharing()) { stopScreenShare(); assistantSay('Screen sharing stopped.'); }
    else { assistantSay('Screen sharing is already off.'); }
    return true;
  }
  if (SCREEN_ON_RE.test(text)) {
    if (isSharing()) assistantSay('Screen sharing is already on.');
    else await startScreenShare();
    return true;
  }
  return false;
}

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
      // A bad frame (e.g. an unusual device sample rate that the downsampler
      // rejects) must not throw out of the audio callback and wedge mic capture.
      try {
        const { samples, rate } = e.data;
        const pcm = window.AriaAudio.micFrameToPcm16k(samples, rate);
        aria.mic.sendAudio(pcm);
        if (vadActive) updateVad(samples);
      } catch (err) {
        if (!startMicCapture._warned) {
          console.error('[ARIA] mic frame dropped:', err && err.message);
          startMicCapture._warned = true;
        }
      }
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

// Barge-in: the user started talking to ARIA (wake word, global/in-window
// shortcut, or push-to-talk) while it was still thinking or speaking. Stop the
// voice, abort the in-flight reply on the main side, and discard any
// half-streamed text so the correction starts a clean turn. This is what lets
// you cut ARIA off mid-answer with "hey jarvis…" to redirect it.
function bargeIn() {
  cancelThinkingHold();
  try { aria.llm.cancel(); } catch (e) {}   // stop generating server-side
  stopPlayback(true);                        // halt audio + cancel TTS synthesis
  resetTtsStream();                          // drop any half-buffered sentence
  // Finalize any in-progress streaming assistant bubble so the next reply opens
  // a fresh message instead of appending to the interrupted one.
  try { flushStream(); } catch (e) {}
  streamBuf = '';
  streamTextNode = null;
  currentAssistantMsg = null;
  currentToolsEl = null;
  toolChips = null;
  pendingRoute = null;
}

function beginUtterance(opts) {
  bargeIn(); // interrupt whatever ARIA is currently saying/generating
  const turnId = perf.newTurn('voice');
  currentTurnId = turnId;
  currentVoiceTurnId = turnId;
  resetTurnMarkers();
  perf.mark(turnId, 'audio_start');
  listening = true;
  micBtn.classList.add('listening');
  orbState('listening');
  aria.stt.start(turnId);
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
  perf.mark(currentVoiceTurnId, 'audio_end');
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
    perf.mark(currentVoiceTurnId, 'stt_result_render', { chars: text.trim().length });
    // Chain the recognized text onto the SAME voice turn so audio_start..tts_*
    // are one timeline; clear it so a later typed turn starts fresh.
    submitUserMessage(text, currentVoiceTurnId); // handles screen-share commands + frame attachment
    currentVoiceTurnId = null;
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

// Token streaming is batched: tokens accumulate in a buffer and the DOM is
// updated at most once per animation frame (a single text-node write + one
// scroll). Previously every token appended a node AND read scrollHeight, which
// forces a synchronous reflow per token — that layout thrashing is what dragged
// the UI to ~5 FPS while the agent was responding.
let streamTextNode = null;
let streamBuf = '';
let streamFlushScheduled = false;
// Tool-usage row for the in-progress assistant message (the harness's tool calls
// are shown here, above the reply text). Reset whenever the message is.
let currentToolsEl = null;
let toolChips = null; // Map<toolName, { el, count, countEl }>

function ensureAssistantMsg() {
  if (currentAssistantMsg) return;
  currentAssistantMsg = addMessage('assistant', '');
  if (pendingRoute) {
    const badge = document.createElement('span');
    badge.className = 'route-badge route-' + pendingRoute.target;
    badge.textContent = pendingRoute.name;
    currentAssistantMsg.appendChild(badge);
    pendingRoute = null;
  }
  // Tools the harness invokes get listed here, ABOVE the answer text. Hidden
  // until the first tool actually arrives so plain chat replies have no empty row.
  currentToolsEl = document.createElement('div');
  currentToolsEl.className = 'msg-tools';
  currentToolsEl.style.display = 'none';
  toolChips = new Map();
  currentAssistantMsg.appendChild(currentToolsEl);

  streamTextNode = document.createTextNode('');
  currentAssistantMsg.appendChild(streamTextNode);
}

// Show (or bump the count on) a chip for a tool the harness just used.
function addToolChip(info) {
  ensureAssistantMsg();
  if (!currentToolsEl) return;
  const name = (info && info.name ? String(info.name) : '').trim();
  if (!name) return;
  currentToolsEl.style.display = '';
  const existing = toolChips.get(name);
  if (existing) { // same tool called again -> show a ×N count instead of a dupe
    existing.count += 1;
    existing.countEl.textContent = '×' + existing.count;
    existing.countEl.style.display = '';
    return;
  }
  const chip = document.createElement('span');
  chip.className = 'tool-chip';
  const icon = document.createElement('span');
  icon.className = 'tool-chip-icon';
  icon.textContent = '🔧';
  const label = document.createElement('span');
  label.textContent = name;
  const countEl = document.createElement('span');
  countEl.className = 'tool-chip-count';
  countEl.style.display = 'none';
  chip.append(icon, label, countEl);
  if (info && info.args) chip.title = String(info.args).slice(0, 240);
  currentToolsEl.appendChild(chip);
  toolChips.set(name, { el: chip, count: 1, countEl });
  conversationEl.scrollTop = conversationEl.scrollHeight;
}

function flushStream() {
  streamFlushScheduled = false;
  if (!streamBuf) return;
  if (streamTextNode) streamTextNode.nodeValue += streamBuf;
  streamBuf = '';
  conversationEl.scrollTop = conversationEl.scrollHeight; // one reflow per frame
}

// --- Incremental TTS: speak each sentence as the LLM produces it ---------
// Waiting for the whole reply (onDone) before synthesizing meant audio didn't
// start until generation finished, then added the engine's first-chunk cost on
// top — a large, "robotic"-feeling gap after the text appeared. Instead we feed
// completed sentences to TTS as tokens stream in, so the voice starts within a
// sentence of the first token and plays gaplessly (chunks schedule back-to-back
// as long as stopPlayback() isn't called between them).
let ttsStreamBuf = '';       // text accumulated from tokens, not yet spoken
let ttsTurnSpeaking = false;  // have we begun speaking the current response?
// A sentence ends at . ! ? (with any trailing quote/bracket) followed by
// whitespace or end-of-buffer. Decimals ("3.5") and "U.S." won't match — they
// have no following space — so they aren't split mid-number.
const TTS_SENTENCE_END = /[.!?]+["')\]]*(?=\s|$)/g;
// A clause boundary: , ; : followed by whitespace. Used only to get the FIRST
// chunk of a reply out fast (see below); "1,000" / "12:30" won't match (no
// following space).
const TTS_CLAUSE_END = /[,;:]["')\]]*(?=\s)/g;
// The biggest lever on perceived latency is time-to-first-audio. Waiting for a
// whole sentence meant a long opening sentence ("The weather in San Francisco
// today is …, with …, and ….") held back all audio until it fully streamed AND
// synthesized — the "it waits for the text output" feeling, worst on long
// replies. So chunk #1 is eager: speak at the first clause boundary (or a hard
// word-boundary cap) once there's enough to sound natural. Later chunks prefer
// full sentences for prosody, but are still capped so one runaway sentence
// can't stall playback (or force Kokoro to synth a single huge blocking chunk).
const TTS_FIRST_MIN = 18;   // don't speak a fragment shorter than this
const TTS_FIRST_MAX = 90;   // ...but don't wait past this for chunk #1
const TTS_LATER_MAX = 220;  // hard cap for subsequent chunks

function speakChunk(text) {
  if (!text) return;
  if (!ttsTurnSpeaking) {
    stopPlayback(true);   // cut any prior/filler audio once, at turn start
    orbState('speaking'); // agent is about to talk -> dynamic motion
    ttsTurnSpeaking = true;
  }
  if (!ttsFirstRequestMarked) { ttsFirstRequestMarked = true; perf.mark(currentTurnId, 'tts_first_request'); }
  ttsPlay(text);          // queues serially behind earlier sentences in the sidecar
}

// Where to cut the next speakable chunk out of `buf`, or -1 to keep buffering.
// `isFirst` makes chunk #1 eager so audio starts within a beat.
function nextTtsCut(buf, isFirst) {
  TTS_SENTENCE_END.lastIndex = 0;
  const sm = TTS_SENTENCE_END.exec(buf);
  const sentenceEnd = sm ? TTS_SENTENCE_END.lastIndex : -1;

  if (isFirst) {
    TTS_CLAUSE_END.lastIndex = 0;
    let m;
    while ((m = TTS_CLAUSE_END.exec(buf)) !== null) {
      const idx = TTS_CLAUSE_END.lastIndex;
      if (idx >= TTS_FIRST_MIN) return sentenceEnd > 0 ? Math.min(idx, sentenceEnd) : idx;
    }
    if (sentenceEnd > 0) return sentenceEnd;
    if (buf.length >= TTS_FIRST_MAX) {
      const sp = buf.lastIndexOf(' ', TTS_FIRST_MAX);
      if (sp >= TTS_FIRST_MIN) return sp + 1;
    }
    return -1;
  }

  if (sentenceEnd > 0) return sentenceEnd;
  if (buf.length >= TTS_LATER_MAX) {
    const sp = buf.lastIndexOf(' ', TTS_LATER_MAX);
    if (sp >= 40) return sp + 1;
  }
  return -1;
}

// Pull every ready chunk out of the buffer and speak it; keep the trailing
// partial until more tokens (or onDone) complete it. Only the very first chunk
// of a turn is eager (isFirst flips false once speakChunk sets ttsTurnSpeaking).
function feedTtsStream(token) {
  ttsStreamBuf += token;
  for (;;) {
    const cut = nextTtsCut(ttsStreamBuf, !ttsTurnSpeaking);
    if (cut <= 0) break;
    const ready = ttsStreamBuf.slice(0, cut).trim();
    ttsStreamBuf = ttsStreamBuf.slice(cut);
    if (ready) speakChunk(ready);
  }
}

function resetTtsStream() { ttsStreamBuf = ''; ttsTurnSpeaking = false; }

// A tool the harness invoked — show it above the reply as it happens.
aria.llm.onTool((info) => { try { addToolChip(info); } catch (e) {} });

aria.llm.onToken((token) => {
  if (!firstTokenRenderMarked) { firstTokenRenderMarked = true; perf.mark(currentTurnId, 'first_token_render'); }
  cancelThinkingHold(); // reply has started — no "hold on" needed
  ensureAssistantMsg();
  streamBuf += token;
  if (!streamFlushScheduled) {
    streamFlushScheduled = true;
    requestAnimationFrame(flushStream);
  }
  feedTtsStream(token);
});

aria.llm.onDone((fullText) => {
  perf.mark(currentTurnId, 'turn_complete', { chars: (fullText || '').length });
  cancelThinkingHold();
  flushStream(); // drain any tokens buffered since the last frame
  // Streaming already populated the message text (preserving the route badge);
  // only fill in if nothing streamed (e.g. non-streaming reply).
  if (currentAssistantMsg && !currentAssistantMsg.textContent.trim()) {
    if (streamTextNode) streamTextNode.nodeValue = fullText;
    else currentAssistantMsg.appendChild(document.createTextNode(fullText));
  }
  currentAssistantMsg = null;
  streamTextNode = null;
  currentToolsEl = null;
  toolChips = null;
  pendingRoute = null;
  // Speak the final partial sentence. If nothing was streamed (non-streaming
  // reply), speak the whole text — orbState('speaking') is set inside speakChunk.
  const rest = ttsStreamBuf.trim();
  ttsStreamBuf = '';
  if (rest) speakChunk(rest);
  else if (!ttsTurnSpeaking && fullText && fullText.trim()) speakChunk(fullText.trim());
  ttsTurnSpeaking = false; // next response starts a fresh turn
});

// --- TTS PCM playback via Web Audio (gapless sentence-chunk scheduling) ---
// 16-bit mono PCM streams in; each chunk announces its own sample rate over the
// state channel (Kokoro = 24000 Hz, Piper = 22050 Hz). We let the AudioContext
// run at the device's native rate and tag each AudioBuffer with the chunk's true
// rate, so Web Audio resamples correctly regardless of engine. Chunks are
// scheduled back-to-back so sentence chunks play seamlessly as they stream in.
let ttsChunkRate = 24000; // updated per chunk from the 'chunk' state message
let audioCtx = null;
let nextPlayTime = 0;
let ttsSources = [];      // currently scheduled buffer sources (this utterance)
let idleTimer = null;

function getAudioCtx() {
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext();
      // Analyser between playback and output drives the reactive orb.
      ttsAnalyser = audioCtx.createAnalyser();
      ttsAnalyser.fftSize = 1024;
      ttsAnalyser.smoothingTimeConstant = 0.6;
      ttsAnalyser.connect(audioCtx.destination);
      pollTtsLevel();
    } catch (e) {
      // Audio output unavailable — keep the app alive; speech just won't play.
      audioCtx = null;
      showError('Audio output unavailable — replies will still appear as text.');
      return null;
    }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Hard-stop the current utterance's audio (used when a new utterance begins, so
// the agent never speaks over itself). Cancels the sidecar synth too.
function stopPlayback(cancelSidecar) {
  for (const s of ttsSources) { try { s.onended = null; s.stop(); } catch (e) {} }
  ttsSources = [];
  nextPlayTime = 0;
  // Drop any PCM still in flight from the interrupted utterance until the next
  // intentional ttsPlay() re-arms playback — otherwise the sidecar's already-
  // emitted tail would leak out after we've "stopped".
  ttsMuted = true;
  if (cancelSidecar) { try { aria.tts.stop(); } catch (e) {} }
}

let ttsAnalyser = null;
const _analyserBuf = new Float32Array(1024);

// Sample the TTS analyser and feed the orb WHILE audio is playing. Gated on
// active sources: the analyser is created once and never torn down, so without
// this guard the 1024-sample RMS ran every frame at the display's native refresh
// forever — a second always-on CPU drain next to the orb. When nothing is
// playing this is now just a cheap reschedule.
function pollTtsLevel() {
  if (ttsSources.length && ttsAnalyser && window.AriaOrb) {
    ttsAnalyser.getFloatTimeDomainData(_analyserBuf);
    let sum = 0;
    for (let i = 0; i < _analyserBuf.length; i++) sum += _analyserBuf[i] * _analyserBuf[i];
    const rms = Math.sqrt(sum / _analyserBuf.length);
    // Map speech RMS (~0..0.3) into a lively 0..1 orb level.
    window.AriaOrb.setLevel(Math.min(1, rms * 3.2));
  }
  requestAnimationFrame(pollTtsLevel);
}

// Trailing odd byte carried from a PCM segment that didn't end on a sample
// boundary (see below), prepended to the next segment.
let pcmCarryByte = -1;

aria.tts.onAudio((pcmArrayBuffer) => {
  if (ttsMuted) return; // interrupted: discard the stale tail of a stopped reply
  try {
    // The PCM stream arrives in arbitrarily-sized UDS segments that are NOT
    // aligned to the 2-byte sample boundary. Building an Int16Array over an
    // odd-length buffer throws ("byte length must be a multiple of 2") — an
    // intermittent renderer crash. Carry any trailing odd byte into the next
    // segment so every sample is reconstructed intact.
    let bytes = new Uint8Array(pcmArrayBuffer);
    if (pcmCarryByte >= 0) {
      const merged = new Uint8Array(bytes.length + 1);
      merged[0] = pcmCarryByte;
      merged.set(bytes, 1);
      bytes = merged;
      pcmCarryByte = -1;
    }
    if (bytes.length % 2 === 1) {
      pcmCarryByte = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length === 0) return;

    const ctx = getAudioCtx();
    if (!ctx) return; // audio unavailable (e.g. AudioContext construction failed)
    // bytes starts at offset 0 with even length, so the Int16 view is aligned.
    const int16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = ctx.createBuffer(1, float32.length, ttsChunkRate);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ttsAnalyser);

    const now = ctx.currentTime;
    // Small lead so the very first chunk isn't clipped while the graph spins up.
    if (nextPlayTime < now + 0.03) nextPlayTime = now + 0.03;
    source.start(nextPlayTime);
    if (!ttsFirstAudioMarked) { ttsFirstAudioMarked = true; perf.mark(currentTurnId, 'tts_first_audio'); }
    nextPlayTime += buffer.duration;
    ttsSources.push(source);
    source.onended = () => {
      const i = ttsSources.indexOf(source);
      if (i >= 0) ttsSources.splice(i, 1);
    };
  } catch (e) {
    // One bad audio segment must never kill the renderer — drop it and continue.
    console.error('[ARIA] tts audio chunk dropped:', e && e.message);
  }
});

aria.tts.onState((state) => {
  if (!state) return;
  if (state.state === 'chunk') {
    if (state.sample_rate) ttsChunkRate = state.sample_rate; // true rate for buffers
    // A new utterance's first sentence: clear any leftover scheduling so chunks
    // line up seamlessly (backstop to stopPlayback at play time).
    if (state.index === 0 && idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
  if (state.state === 'done') {
    // Return to idle only after ALL buffered audio has finished — including the
    // final chunk's full tail (no early cutoff). +250ms guard.
    const remainMs = audioCtx ? Math.max(0, (nextPlayTime - audioCtx.currentTime) * 1000) : 0;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (ttsSources.length === 0) orbState('idle'); }, remainMs + 250);
    // NOTE: do NOT reset nextPlayTime here — that previously let the tail be
    // overwritten/clipped. It's reset by stopPlayback() when the next turn starts.
  }
});

aria.llm.onError((error) => {
  cancelThinkingHold();
  streamBuf = '';
  streamTextNode = null;
  currentAssistantMsg = null;
  currentToolsEl = null;
  toolChips = null;
  resetTtsStream(); // drop any half-buffered sentence; turn is over
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
  llmProvider: document.getElementById('cfg-llm-provider'),
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

// Populate the conversational-LLM provider dropdown once.
for (const p of window.AriaHarnesses.PROVIDERS) {
  const opt = document.createElement('option');
  opt.value = p.id;
  opt.textContent = p.name;
  cfg.llmProvider.appendChild(opt);
}
// Picking a provider fills its endpoint + default model (still editable).
cfg.llmProvider.addEventListener('change', () => {
  const p = window.AriaHarnesses.providerById(cfg.llmProvider.value);
  if (!p) return;
  if (p.endpoint) cfg.llmEndpoint.value = p.endpoint;
  if (p.defaultModel) cfg.llmModel.value = p.defaultModel;
});

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
  // Show saved keys so they don't look lost (password field keeps them masked).
  cfg.llmKey.value = (await aria.secure.get('llm-api-key')) || '';
  // Reflect the provider dropdown from the saved endpoint.
  cfg.llmProvider.value = (window.AriaHarnesses.providerFromEndpoint(cfg.llmEndpoint.value) || {}).id || 'custom';
  cfg.harnessEndpoint.value = (await aria.config.get('harness.endpoint')) || '';
  cfg.harnessModel.value = (await aria.config.get('harness.model')) || '';
  cfg.harnessKey.value = (await aria.secure.get('harness-api-key')) || '';
  const savedHarness = (await aria.config.get('harness.id')) || '';
  const inferred = savedHarness || (window.AriaHarnesses.fromEndpoint(cfg.harnessEndpoint.value) || {}).id || 'custom';
  cfg.harness.value = inferred;
  applyHarnessSelection(inferred, { prefill: false });
  cfg.sttModel.value = (await aria.config.get('stt.model')) || 'small';
  cfg.sttBackend.value = (await aria.config.get('stt.backend')) || 'vulkan';
  cfg.ttsVoice.value = (await aria.config.get('tts.voice')) || 'bm_george';
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
  await aria.config.set('wakeword.phrase', cfg.wwPhrase.value.trim());
  await aria.config.set('ui.theme', cfg.theme.value);
  applyTheme(cfg.theme.value);

  // Persist exactly what's in the key fields (they stay populated, not cleared).
  const lk = cfg.llmKey.value.trim();
  lk ? await aria.secure.set('llm-api-key', lk) : await aria.secure.delete('llm-api-key');
  const hk = cfg.harnessKey.value.trim();
  hk ? await aria.secure.set('harness-api-key', hk) : await aria.secure.delete('harness-api-key');

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
  llmProvider: document.getElementById('onb-llm-provider'),
  llmEndpoint: document.getElementById('onb-llm-endpoint'),
  llmModel: document.getElementById('onb-llm-model'),
  llmKey: document.getElementById('onb-llm-key'),
  llmTest: document.getElementById('onb-llm-test'),
  llmTestResult: document.getElementById('onb-llm-test-result'),
  mic: document.getElementById('onb-mic'),
  micResult: document.getElementById('onb-mic-result'),
  wake: document.getElementById('onb-wake'),
};
let onbStep = 0;
const ONB_LAST = 5;

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

// Direct conversational-LLM provider step: same preset list as Settings. Picking
// a provider pre-fills its endpoint + default model (both stay editable).
for (const p of window.AriaHarnesses.PROVIDERS) {
  const o = document.createElement('option');
  o.value = p.id; o.textContent = p.name;
  onb.llmProvider.appendChild(o);
}
function onbApplyLlmProvider() {
  const p = window.AriaHarnesses.providerById(onb.llmProvider.value);
  if (!p) return;
  // Local providers ignore the key; hint that it's optional for them.
  onb.llmKey.placeholder = p.keyHint || 'optional';
  if (p.endpoint) onb.llmEndpoint.value = p.endpoint;
  if (p.defaultModel) onb.llmModel.value = p.defaultModel;
}
onb.llmProvider.addEventListener('change', onbApplyLlmProvider);

// Test the direct-LLM connection: one short round-trip via the same LLM_TEST
// path the harness step uses, but with the LLM endpoint/model/key.
onb.llmTest.addEventListener('click', async () => {
  const endpoint = onb.llmEndpoint.value.trim();
  if (!endpoint) { onb.llmTestResult.textContent = 'Enter an endpoint first'; onb.llmTestResult.className = 'err-msg'; return; }
  onb.llmTest.disabled = true;
  onb.llmTestResult.textContent = 'Testing…';
  onb.llmTestResult.className = '';
  if (onb.llmKey.value.trim()) await aria.secure.set('llm-api-key', onb.llmKey.value.trim());
  const apiKey = await aria.secure.get('llm-api-key');
  const r = await aria.llm.test({ endpoint, model: onb.llmModel.value.trim(), apiKey });
  if (r.ok) { onb.llmTestResult.textContent = '✓ Connected'; onb.llmTestResult.className = 'ok-msg'; }
  else { onb.llmTestResult.textContent = '✕ ' + (r.error || 'failed'); onb.llmTestResult.className = 'err-msg'; }
  onb.llmTest.disabled = false;
});

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
  // Onboarding configures the agent harness (tool-using tasks) and/or a direct
  // conversational LLM provider — either or both. Only persist a target whose
  // endpoint was actually filled in, so skipping one doesn't overwrite the other.
  const harnessEp = onbResolveEndpoint();
  if (harnessEp) {
    await aria.config.set('harness.id', onb.harness.value);
    await aria.config.set('harness.endpoint', harnessEp);
    await aria.config.set('harness.model', onb.model.value.trim());
    if (onb.key.value.trim()) await aria.secure.set('harness-api-key', onb.key.value.trim());
  }
  const llmEp = onb.llmEndpoint.value.trim();
  if (llmEp) {
    await aria.config.set('llm.endpoint', llmEp);
    await aria.config.set('llm.model', onb.llmModel.value.trim());
    if (onb.llmKey.value.trim()) await aria.secure.set('llm-api-key', onb.llmKey.value.trim());
  }
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
    // Default the LLM provider to "custom" so the step starts empty (and stays
    // optional — a blank endpoint is skipped on finish). Picking a preset fills it.
    onb.llmProvider.value = 'custom';
    onbStep = 0;
    onbRender();
    onb.overlay.classList.add('visible');
  }
})();
})();
