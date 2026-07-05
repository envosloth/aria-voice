// Wrapped in an IIFE: top-level `const`s here (aria, etc.) must NOT be global
// lexical bindings — contextBridge exposes `aria` as a non-configurable global
// property, and a global-scope `const aria` collides with it (SyntaxError:
// "Identifier 'aria' has already been declared"). Function scope avoids that.
(function () {
'use strict';
const { aria } = window;

// Latency harness (see perf.js / src/main/perf.ts). Safe no-op stub if perf.js
// didn't load, so instrumenting the hot path never risks a ReferenceError.
const perf = window.AriaPerf || {
  newTurn: () => '', mark: () => {}, isEnabled: () => false,
  setTurnMeta: () => {}, recentTurns: () => [], lastStages: () => null, onUpdate: () => {},
};
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
// Chat header subtitle: show what actually answers (harness id / model),
// like the design's "vector-cli / sonnet-5". Falls back to the LLM model.
async function updateChatSub() {
  const el = document.getElementById('chat-sub');
  if (!el) return;
  try {
    const [hid, hmodel, lmodel] = await Promise.all([
      aria.config.get('harness.id'), aria.config.get('harness.model'), aria.config.get('llm.model'),
    ]);
    const parts = [];
    if (hid) parts.push(hid);
    const model = hmodel || lmodel;
    if (model) parts.push(model);
    el.textContent = parts.length ? parts.join(' / ') : 'aria · voice';
  } catch (e) { /* keep placeholder */ }
}

// Apply the saved theme as early as possible to avoid a flash.
(async () => {
  try { applyTheme((await aria.config.get('ui.theme')) || 'midnight'); } catch (e) {}
  try { const v = await aria.config.get('audio.volume'); if (typeof v === 'number') setOutputVolume(v); } catch (e) {}
  updateChatSub();
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

// Autoscroll only when the user is already pinned near the bottom — scrolling
// up to read history must never be yanked back down by a streaming reply.
function scrollIfPinned(pinned) {
  if (pinned) conversationEl.scrollTop = conversationEl.scrollHeight;
}
function isPinned() {
  return conversationEl.scrollHeight - conversationEl.scrollTop - conversationEl.clientHeight < 80;
}

// Keep the transcript DOM bounded: an always-on assistant accumulates messages
// for days; past ~200 the old nodes only cost memory + layout time.
const MAX_MESSAGES = 200;

function addMessage(role, text) {
  const pinned = isPinned();
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.textContent = text;
  // Timestamp for this message, shown only on hover (CSS ::after from data-time,
  // so it's not part of textContent and doesn't disturb the streaming/onDone
  // text checks). HH:MM in the user's locale.
  div.dataset.time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  conversationEl.appendChild(div);
  while (conversationEl.childElementCount > MAX_MESSAGES) conversationEl.removeChild(conversationEl.firstChild);
  scrollIfPinned(pinned);
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
  // Remember whether this turn came from voice so conversation mode only chains
  // a follow-up listen after spoken exchanges, never after a typed message.
  lastTurnWasVoice = !!existingTurnId;
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
//
// Two stages so the user is kept in the loop both FAST and during genuinely long
// agent/tool runs:
//   - first nudge at HOLD_FIRST_MS (short silence -> "we heard you, working on it"),
//   - an escalation at HOLD_ESCALATE_MS so a 20s+ tool run isn't dead silence.
// The filler must never be cut off mid-word by the real reply: `fillerSpeaking`
// tells speakChunk() to queue the reply serially BEHIND the filler (gapless via the
// sidecar synth queue) instead of hard-stopping it. A real USER barge-in still
// interrupts instantly (bargeIn -> stopPlayback clears the flag).
let thinkingTimer = null;
let thinkingTimer2 = null;
let awaitingFirstToken = false;
let fillerSpeaking = false;
let pendingFillerPhrase = null; // computed at submit, spoken only if the harness route drags
// The filler ("one moment, let me look that up") is only worth speaking when the
// reply will genuinely take a while — i.e. the agent harness is off running
// tools. The direct LLM answers fast and never needs it, so we don't even arm
// the timer until onRoute confirms the turn went to the harness. And even then
// only after a real silence: a tool-less harness reply streams its first token
// within a couple seconds, so 5s of dead air is the "this one's actually long"
// signal — long enough not to fire on quick replies, short enough to reassure.
const HOLD_FIRST_MS = 5000;
const HOLD_ESCALATE_MS = 15000;

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

// Speak a spoken-only filler and protect it: the real reply will queue behind it
// rather than truncate it. `speakOnly` runs stopPlayback first (which clears the
// flag), so set the flag AFTER it.
function speakFiller(phrase) {
  speakOnly(phrase);
  fillerSpeaking = true;
}

// Called at submit, BEFORE the route is known. We only remember the turn is
// in flight and pre-compute the phrase; the timers are started later by
// armFillerForHarness() once onRoute says the agent harness took the turn.
function armThinkingHold(text) {
  clearTimeout(thinkingTimer);
  clearTimeout(thinkingTimer2);
  awaitingFirstToken = true;
  pendingFillerPhrase = holdOnPhrase(text);
}

// The turn routed to the agent harness — the only path slow enough to warrant a
// spoken "hold on". Start the two hold timers now. The fast LLM path calls
// cancelThinkingHold() instead, so it never speaks a filler.
function armFillerForHarness() {
  if (!awaitingFirstToken || !pendingFillerPhrase) return;
  const phrase = pendingFillerPhrase;
  clearTimeout(thinkingTimer);
  clearTimeout(thinkingTimer2);
  thinkingTimer = setTimeout(() => {
    if (awaitingFirstToken) speakFiller(phrase);
  }, HOLD_FIRST_MS);
  thinkingTimer2 = setTimeout(() => {
    if (awaitingFirstToken) speakFiller('Still working on it — hang tight.');
  }, HOLD_ESCALATE_MS);
}

function cancelThinkingHold() {
  awaitingFirstToken = false;
  pendingFillerPhrase = null;
  clearTimeout(thinkingTimer);
  clearTimeout(thinkingTimer2);
  thinkingTimer = null;
  thinkingTimer2 = null;
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
// Calibration knobs for the desktop frame sent to the vision model. Width drives
// the vision tile count (the dominant cost): 768 -> 2 tiles wide. Drop toward 512
// for ~half the tiles (faster, less legible) if screen-share replies still drag.
// Server-side `detail` (router.ts) is the other half of this lever.
const SCREEN_FRAME_MAX_W = 768;
const SCREEN_FRAME_QUALITY = 0.45;
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
    // Fires when sharing ends for a reason OTHER than our own stop() — e.g. the
    // user clicks "Stop sharing" in the OS portal. If we already stopped it
    // ourselves (screenStream is null), don't add a second "stopped" message.
    screenTrack.addEventListener('ended', () => {
      if (!isSharing()) return;
      stopScreenShare();
      assistantSay('Screen sharing stopped.');
    });
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
    const scale = Math.min(1, SCREEN_FRAME_MAX_W / srcW);
    const cw = Math.max(1, Math.round(srcW * scale));
    const ch = Math.max(1, Math.round(srcH * scale));
    screenCanvas.width = cw; screenCanvas.height = ch;
    screenCanvas.getContext('2d').drawImage(drawable, 0, 0, cw, ch);
    if (drawable.close) drawable.close(); // free the ImageBitmap
    return screenCanvas.toDataURL('image/jpeg', SCREEN_FRAME_QUALITY);
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

// Energy-based endpointing for hands-free (wake-word) utterances: after ~550ms
// of silence (once speech has been seen) the utterance ends. Logic lives in the
// shared, unit-tested VadEndpointer; here we just drive it and cap the duration.
let vadActive = false;
let vad = null;
let vadSafetyTimer = null;

// --- Conversation mode: after ARIA finishes speaking to a voice turn, it
// re-opens the mic for a few seconds so the user can keep talking naturally
// without re-saying the wake word. Off by default (config conversation.enabled).
let conversationMode = false;
let lastTurnWasVoice = false;   // was the turn being answered started by voice?
let followupTimer = null;       // delay between reply-end and re-listening
let noSpeechTimer = null;       // closes a follow-up window if nobody speaks
let discardSttResult = false;   // drop the next STT result (silent follow-up)
// How long a follow-up window waits for the user to START talking before it
// gives up and returns to idle. Long enough to react to a reply, short enough
// that the mic isn't hanging open. Once speech starts, VAD endpointing takes over.
const FOLLOWUP_NO_SPEECH_MS = 6000;
try { aria.config.get('conversation.enabled').then((v) => { conversationMode = !!v; }); } catch (e) {}

function updateVad(samples) {
  if (vad && vad.pushFrame(samples)) endUtterance();
}

// Drive the orb's visual state through the conversation pipeline. `orbStateName`
// mirrors the orb's current state in the renderer so the TTS-drain logic can tell
// whether it's still "speaking" before flipping back to idle (so a barge-in that
// already moved us to 'listening' is never clobbered by a late audio-end).
let orbStateName = 'idle';
function orbState(s) { orbStateName = s; document.body.dataset.state = s; if (window.AriaOrb) window.AriaOrb.setState(s); }

// Barge-in: the user started talking to ARIA (wake word, global/in-window
// shortcut, or push-to-talk) while it was still thinking or speaking. Stop the
// voice, abort the in-flight reply on the main side, and discard any
// half-streamed text so the correction starts a clean turn. This is what lets
// you cut ARIA off mid-answer with "hey jarvis…" to redirect it.
function bargeIn() {
  cancelThinkingHold();
  clearTimeout(followupTimer); followupTimer = null; // cancel a queued auto-listen
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
  // Tell the orb an STT transcription is starting so the GPU-bound render can
  // swap in its throttled cap (the "high" tier native-refresh + Vulkan STT
  // combo was the crash path on 'balanced' and above).
  try { window.AriaOrb && window.AriaOrb.beginStt && window.AriaOrb.beginStt(); } catch (e) {}
  aria.stt.start(turnId);
  // VAD endpointing only for hands-free (wake-word) turns; push-to-talk ends on
  // button release.
  vadActive = !!(opts && opts.vad);
  // Endpoint after ~550ms of silence (not the old 800ms) so transcription starts
  // sooner once the user stops talking — the single biggest perceived-latency win
  // for hands-free turns. Still long enough to ride over a natural mid-sentence
  // pause; the 8s hard cap below bounds a stuck utterance.
  vad = vadActive ? new window.AriaAudio.VadEndpointer({ frameMs: 20, hangMs: 550 }) : null;
  clearTimeout(vadSafetyTimer);
  if (vadActive) vadSafetyTimer = setTimeout(endUtterance, 8000); // hard cap
  // Follow-up (conversation-mode) window: if no speech starts within a few
  // seconds, close it silently. Crucially this DISCARDS the STT result rather
  // than sending it — whisper hallucinates phantom phrases on pure silence
  // ("Thank you.", "you"), and those must never become a fake user turn.
  clearTimeout(noSpeechTimer); noSpeechTimer = null;
  if (opts && opts.followup) {
    noSpeechTimer = setTimeout(() => {
      if (vad && !vad.hasSpeech()) endUtterance({ discard: true });
    }, FOLLOWUP_NO_SPEECH_MS);
  }
}

function endUtterance(opts) {
  if (!listening) return;
  listening = false;
  vadActive = false;
  vad = null;
  clearTimeout(vadSafetyTimer);
  clearTimeout(noSpeechTimer); noSpeechTimer = null;
  micBtn.classList.remove('listening');
  perf.mark(currentVoiceTurnId, 'audio_end');
  // A silent follow-up: finalize STT to keep the sidecar clean but drop whatever
  // it returns, and go straight back to idle instead of flashing 'processing'.
  if (opts && opts.discard) {
    discardSttResult = true;
    orbState('idle');
  } else {
    orbState('processing'); // STT + LLM working
  }
  aria.stt.end();
}

// Re-open the mic after a spoken reply so the user can continue the conversation
// hands-free. Only for voice turns, only when enabled, and only if nothing else
// grabbed the pipeline in the meantime.
function maybeStartFollowup() {
  if (!conversationMode || !lastTurnWasVoice) return;
  clearTimeout(followupTimer);
  followupTimer = setTimeout(() => {
    if (orbStateName !== 'idle') return; // a barge-in / manual action took over
    beginUtterance({ vad: true, followup: true });
  }, 500);
}

micBtn.addEventListener('mousedown', beginUtterance);
micBtn.addEventListener('mouseup', endUtterance);
micBtn.addEventListener('mouseleave', endUtterance);

// Start capturing as soon as we have a user gesture (autoplay policy) or load.
startMicCapture();

aria.stt.onResult((text) => {
  // STT transcription is done; lift the orb's GPU throttling. The orb flips
  // back to its per-state cap (full refresh on the high tier). Wrapped in a
  // try/catch in case the orb isn't ready yet (tests, headless boot).
  try { window.AriaOrb && window.AriaOrb.endStt && window.AriaOrb.endStt(); } catch (e) {}
  // A silent follow-up window was closed: drop this result (it's silence, and
  // whisper may have hallucinated a phantom phrase) and stay idle.
  if (discardSttResult) { discardSttResult = false; partialEl.textContent = ''; orbState('idle'); return; }
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
  // Cmd/Ctrl+, opens Settings (the sidebar shows this hint, and the gear is
  // hidden on narrow windows — this keeps Settings reachable at any width).
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    openSettings();
  }
  // Escape closes it.
  if (e.key === 'Escape' && settingsOverlay.classList.contains('visible')) {
    closeSettings();
  }
  const historyOv = document.getElementById('history-overlay');
  if (e.key === 'Escape' && historyOv && historyOv.classList.contains('visible')) {
    historyOv.classList.remove('visible');
  }
});

// Which target (LLM vs Agent harness) the coordinator routed to.
let pendingRoute = null;
aria.llm.onRoute((info) => {
  pendingRoute = info;
  // Only the agent harness runs tools long enough to need a spoken "hold on".
  // Arm the filler for it; the fast LLM path cancels the hold so it stays quiet
  // until it actually replies. (onRoute always arrives after armThinkingHold ran
  // synchronously in submitUserMessage, so pendingFillerPhrase is already set.)
  if (info && info.target === 'harness') armFillerForHarness();
  else cancelThinkingHold();
  // Tag the in-flight turn so the latency panel can label the LLM/Agent stage
  // with which target actually answered (and whether it was a fallback).
  try { perf.setTurnMeta(currentTurnId, { target: info && info.name }); } catch (e) {}
});

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
  scrollIfPinned(isPinned());
}

function flushStream() {
  streamFlushScheduled = false;
  if (!streamBuf) return;
  const pinned = isPinned();
  if (streamTextNode) streamTextNode.nodeValue += streamBuf;
  streamBuf = '';
  scrollIfPinned(pinned); // one reflow per frame
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
    if (fillerSpeaking) {
      // A "hold on" filler is mid-flight — let the reply queue serially behind it
      // (gapless, via the sidecar synth queue) instead of cutting it off mid-word.
      // Just stop the filler's pending 'done' from dropping the orb to idle before
      // the reply, which is queued after it, starts playing.
      clearTimeout(idleTimer); idleTimer = null;
      ttsSynthDone = false;
      fillerSpeaking = false;
    } else {
      stopPlayback(true); // cut any prior/leftover audio once, at turn start
    }
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
  // The agent finished but produced nothing to say (e.g. it only ran tools and
  // returned no summary) — don't leave the user in silence wondering if it heard
  // them. A short spoken nudge is the "asked something and got no answer" fix.
  else if (!ttsTurnSpeaking) speakChunk("Sorry, I didn't get an answer for that — could you try again?");
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
// True once the TTS sidecar has reported 'done' for the current reply (no more
// audio chunks coming). The orb stays green ('speaking') until the last scheduled
// audio actually finishes playing.
let ttsSynthDone = false;

// Schedule the orb's return to idle for the moment the LAST scheduled audio
// finishes. Re-armed on every chunk: the sidecar's stdout 'done' can beat the
// final PCM over the UDS socket, so computing the end time once (at 'done') made
// the orb drop to idle BEFORE the last words played. Re-arming on each chunk keeps
// the deadline at the true audio end. Gated on orbStateName so a barge-in that
// moved us to listening/processing is never overridden.
function armIdleAtAudioEnd() {
  if (!ttsSynthDone) return;
  const remainMs = audioCtx ? Math.max(0, (nextPlayTime - audioCtx.currentTime) * 1000) : 0;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (orbStateName !== 'speaking') return;
    // A "hold on" filler just finished playing but the REAL reply hasn't started
    // streaming yet (awaitingFirstToken is still set) — the turn is NOT over. Do
    // not drop to idle or re-open the mic for a follow-up; the filler is not the
    // end of the turn. Stay 'speaking' and keep waiting. The first real token
    // (speakChunk clears the filler + re-arms) or a failure (onError clears
    // awaitingFirstToken then speaks) will drive the true end-of-turn idle.
    if (awaitingFirstToken) return;
    orbState('idle');
    // The spoken reply has now finished playing — mark the true end of the turn so
    // the latency panel's "full reply" is measured to here (not to turn_complete,
    // which is only when the LLM text finished and can precede the audio).
    try { perf.mark(currentTurnId, 'tts_done'); } catch (e) {}
    // Conversation mode: reply's done, listen for a natural follow-up.
    maybeStartFollowup();
  }, remainMs + 250);
}

function getAudioCtx() {
  if (!audioCtx) {
    try {
      audioCtx = new AudioContext();
      // Analyser between playback and output drives the reactive orb.
      ttsAnalyser = audioCtx.createAnalyser();
      ttsAnalyser.fftSize = 1024;
      ttsAnalyser.smoothingTimeConstant = 0.6;
      // Master output gain (the volume slider). After the analyser so the orb
      // reacts to the speech envelope regardless of volume; nothing else touches
      // this node, so it isn't clobbered by stopPlayback's source-level muting.
      ttsGain = audioCtx.createGain();
      ttsGain.gain.value = outputVolume;
      ttsAnalyser.connect(ttsGain);
      ttsGain.connect(audioCtx.destination);
      // The level poll is started on demand by startTtsLevelPoll() when audio is
      // actually scheduled (see onAudio), and stops itself when playback drains.
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
  fillerSpeaking = false; // audio is being hard-stopped: no filler left to protect
  ttsSynthDone = false;   // a fresh turn is not done until its 'done' state arrives
  clearTimeout(idleTimer); idleTimer = null;
  // Drop any PCM still in flight from the interrupted utterance until the next
  // intentional ttsPlay() re-arms playback — otherwise the sidecar's already-
  // emitted tail would leak out after we've "stopped".
  ttsMuted = true;
  // Also drop any pending half-sample carry byte. Without this, an interruption
  // that left an odd trailing byte would prepend it to the NEXT reply's first
  // PCM segment, misaligning every 16-bit sample and turning the whole reply
  // into noise.
  pcmCarryByte = -1;
  if (cancelSidecar) { try { aria.tts.stop(); } catch (e) {} }
}

let ttsAnalyser = null;
let ttsGain = null;
let outputVolume = 1.0; // TTS master volume 0..1 (audio.volume); applied to ttsGain
// Set the TTS output volume live (slider). Takes effect mid-playback because it
// rides the persistent master gain node, not the per-utterance sources.
function setOutputVolume(v) {
  outputVolume = Math.max(0, Math.min(1, Number(v)));
  if (ttsGain) ttsGain.gain.value = outputVolume;
}
let ttsLevelRaf = null;
const _analyserBuf = new Float32Array(1024);

// Sample the TTS analyser and feed the orb WHILE audio is playing. The loop now
// STOPS itself once nothing is playing instead of rescheduling forever: at the
// orb's native refresh that idle reschedule was a 160+/s wakeup doing nothing, an
// always-on drain. startTtsLevelPoll() re-arms it when the next chunk is scheduled.
function pollTtsLevel() {
  if (!ttsSources.length) { ttsLevelRaf = null; return; } // idle -> stop (re-armed on next chunk)
  if (ttsAnalyser && window.AriaOrb) {
    ttsAnalyser.getFloatTimeDomainData(_analyserBuf);
    let sum = 0;
    for (let i = 0; i < _analyserBuf.length; i++) sum += _analyserBuf[i] * _analyserBuf[i];
    const rms = Math.sqrt(sum / _analyserBuf.length);
    // Map speech RMS (~0..0.3) into a lively 0..1 orb level.
    window.AriaOrb.setLevel(Math.min(1, rms * 3.2));
  }
  ttsLevelRaf = requestAnimationFrame(pollTtsLevel);
}
function startTtsLevelPoll() { if (ttsLevelRaf == null) ttsLevelRaf = requestAnimationFrame(pollTtsLevel); }

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
    startTtsLevelPoll(); // drive the reactive orb only while audio is actually playing
    source.onended = () => {
      const i = ttsSources.indexOf(source);
      if (i >= 0) ttsSources.splice(i, 1);
    };
    // If this chunk landed AFTER the sidecar's 'done', extend the idle deadline to
    // the new (later) audio end so the orb stays green through the final words.
    if (ttsSynthDone) armIdleAtAudioEnd();
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
    // Synthesis finished. Arm the return-to-idle for the moment the last scheduled
    // audio finishes playing; armIdleAtAudioEnd re-arms if more PCM arrives after
    // this (stdout 'done' can beat the final UDS PCM), so the orb holds green for
    // the FULL utterance instead of dropping to idle early.
    ttsSynthDone = true;
    armIdleAtAudioEnd();
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
  showError(`LLM error: ${error}. Text input remains available.`);
  // Speak a short apology (the banner keeps the actionable detail) so a voice
  // turn that failed — most often the agent running past its time budget — isn't
  // just dead air. speakOnly() stops any in-flight filler and flips the orb to
  // 'speaking'; it drains back to idle when the phrase finishes.
  speakOnly("Sorry, I ran into a problem answering that one.");
});

// While ARIA is speaking, only a confidently-heard wake word should barge in.
// The sidecar already gates emission at ~0.4, but marginal fires (0.4–0.6) while
// ARIA is talking are almost always its own leaked audio or room noise — those
// were cutting the reply off mid-sentence. A deliberate user interruption scores
// well above this, so genuine barge-in still works.
const BARGE_IN_MIN_SCORE = 0.6;
aria.wakeword.onDetected((phrase, score) => {
  if (orbStateName === 'speaking' && typeof score === 'number' && score < BARGE_IN_MIN_SCORE) {
    return; // too weak to be a real interruption — don't cut off the reply
  }
  playWakeChime(); // audible "I'm listening" confirmation
  // Wake word heard -> open a hands-free STT utterance with VAD endpointing:
  // it ends automatically after ~550ms of silence (or the 8s safety cap).
  beginUtterance({ vad: true });
});

// Short ascending two-note chime on wake-word activation, so the user hears that
// ARIA started listening. Synthesized with WebAudio (no asset, no dependency)
// and routed through the master gain so it respects the volume slider.
function playWakeChime() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const dest = ttsGain || ctx.destination;
  const now = ctx.currentTime;
  for (const [freq, t] of [[1319, 0], [1976, 0.075]]) { // E6 -> B6
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const start = now + t;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.14, start + 0.012); // soft attack
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.13); // short decay
    osc.connect(g); g.connect(dest);
    osc.start(start);
    osc.stop(start + 0.15);
  }
}

// Lifecycle statuses that actually change a sidecar's health. The supervisor also
// forwards EVERY sidecar stdout line as status 'log' (and emits heartbeats etc.) —
// those are NOT state changes. The old handler blanked the dot on any status, so
// the first time STT logged during a transcription its green dot went dark and
// never came back ("dots stop working after I talk to it"). Now only a recognized
// transition repaints the dot; anything else leaves the last good state intact.
const DOT_CLASS_FOR_STATUS = {
  ready: 'active', started: 'active', initialized: 'active',
  restarting: 'loading', 'circuit-reset': 'loading',
  error: 'error', 'circuit-open': 'error', exited: 'error',
  'memory-exceeded': 'error', 'heartbeat-timeout': 'error',
};
aria.sidecar.onStatus(({ name, status, detail }) => {
  const dot = statusDots[name];
  if (!dot) return;
  const cls = DOT_CLASS_FOR_STATUS[status];
  if (!cls) return; // 'log'/heartbeat/unknown — not a state change; keep the dot as-is
  dot.className = 'status-dot ' + cls;
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
  discoverLlm: document.getElementById('discover-llm'),
  discoverHarness: document.getElementById('discover-harness'),
  discoverLlmStatus: document.getElementById('discover-llm-status'),
  discoverHarnessStatus: document.getElementById('discover-harness-status'),
  detectHarness: document.getElementById('detect-harness'),
  detectHarnessStatus: document.getElementById('detect-harness-status'),
  sttModel: document.getElementById('cfg-stt-model'),
  sttBackend: document.getElementById('cfg-stt-backend'),
  ttsVoice: document.getElementById('cfg-tts-voice'),
  ttsSpeed: document.getElementById('cfg-tts-speed'),
  ttsSpeedVal: document.getElementById('cfg-tts-speed-val'),
  volume: document.getElementById('cfg-volume'),
  volumeVal: document.getElementById('cfg-volume-val'),
  wwEnabled: document.getElementById('cfg-ww-enabled'),
  wwPhrase: document.getElementById('cfg-ww-phrase'),
  conversationEnabled: document.getElementById('cfg-conversation-enabled'),
  theme: document.getElementById('cfg-theme'),
  perfPreset: document.getElementById('cfg-perf-preset'),
  // Remote access (SSH tunnel) — see src/main/tunnel-supervisor.ts.
  remoteEnabled: document.getElementById('cfg-remote-enabled'),
  remoteTarget: document.getElementById('cfg-remote-target'),
  remoteSshHost: document.getElementById('cfg-remote-sshhost'),
  remoteSshPort: document.getElementById('cfg-remote-sshport'),
  remoteIdentity: document.getElementById('cfg-remote-identity'),
  remoteRemoteHost: document.getElementById('cfg-remote-remotehost'),
  remoteRemotePort: document.getElementById('cfg-remote-remoteport'),
  remoteLocalPort: document.getElementById('cfg-remote-localport'),
  remoteAutoReconnect: document.getElementById('cfg-remote-autoreconnect'),
  remoteRawCommand: document.getElementById('cfg-remote-rawcommand'),
  tunnelDot: document.getElementById('tunnel-dot'),
  tunnelLabel: document.getElementById('tunnel-label'),
  tunnelEndpoint: document.getElementById('tunnel-endpoint'),
  tunnelConnect: document.getElementById('tunnel-connect'),
  tunnelDisconnect: document.getElementById('tunnel-disconnect'),
  tunnelCopyUrl: document.getElementById('tunnel-copy-url'),
};

// Volume + speed are live sliders (not gated behind the Save button): volume rides
// the master gain node so it changes mid-playback; speed persists to config, which
// main forwards to the TTS sidecar as a set_speed control (next utterance, no
// reload). input = live/label, change = persist.
if (cfg.volume) {
  const showVol = () => { if (cfg.volumeVal) cfg.volumeVal.textContent = Math.round(cfg.volume.value * 100) + '%'; };
  cfg.volume.addEventListener('input', () => { setOutputVolume(parseFloat(cfg.volume.value)); showVol(); });
  cfg.volume.addEventListener('change', () => { aria.config.set('audio.volume', parseFloat(cfg.volume.value)); });
}
if (cfg.ttsSpeed) {
  const showSpeed = () => { if (cfg.ttsSpeedVal) cfg.ttsSpeedVal.textContent = parseFloat(cfg.ttsSpeed.value).toFixed(2) + '×'; };
  cfg.ttsSpeed.addEventListener('input', showSpeed);
  cfg.ttsSpeed.addEventListener('change', () => { aria.config.set('tts.speed', parseFloat(cfg.ttsSpeed.value)); });
}

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

// Auto-detect a local harness's endpoint + API key from its own on-disk config
// (Hermes -> ~/.hermes/.env, etc.) so the user never has to hunt for the key.
// `force` overwrites already-filled fields (the manual "Auto-detect" button);
// otherwise only blanks are filled (the silent run when a harness is picked).
// Shared by Settings + onboarding — pass whichever element set that surface has.
async function detectHarnessInto(id, els, opts) {
  const { endpointEl, modelEl, keyEl, statusEl } = els;
  const force = !!(opts && opts.force);
  if (statusEl) { statusEl.textContent = 'Looking for a local key…'; statusEl.style.color = 'var(--text-muted)'; }
  let r;
  try { r = await aria.llm.detectHarness(id); }
  catch { if (statusEl) statusEl.textContent = ''; return null; }
  if (r.endpoint && endpointEl && (force || !endpointEl.value.trim())) endpointEl.value = r.endpoint;
  if (r.model && modelEl && (force || !modelEl.value.trim())) modelEl.value = r.model;
  if (r.apiKey && keyEl && (force || !keyEl.value.trim())) keyEl.value = r.apiKey;
  if (statusEl) {
    statusEl.textContent = (r.found ? '✓ ' : '') + (r.message || '');
    statusEl.style.color = r.found ? 'var(--success)' : 'var(--text-muted)';
  }
  return r;
}

// Pick a harness preset -> prefill its endpoint/model + note (all editable), and
// reveal the Auto-detect button for harnesses ARIA can read a local key for.
function applyHarnessSelection(id, opts) {
  const h = window.AriaHarnesses.byId(id) || window.AriaHarnesses.byId('custom');
  cfg.harnessNote.textContent = h.note || '';
  if (cfg.detectHarness) cfg.detectHarness.hidden = !h.detect;
  if (!h.detect && cfg.detectHarnessStatus) cfg.detectHarnessStatus.textContent = '';
  if (opts && opts.prefill) {
    if (h.endpoint) cfg.harnessEndpoint.value = h.endpoint;
    if (h.defaultModel) cfg.harnessModel.value = h.defaultModel;
  }
}
function detectHarnessSettings(force) {
  return detectHarnessInto(cfg.harness.value, {
    endpointEl: cfg.harnessEndpoint, modelEl: cfg.harnessModel,
    keyEl: cfg.harnessKey, statusEl: cfg.detectHarnessStatus,
  }, { force });
}
cfg.harness.addEventListener('change', () => {
  applyHarnessSelection(cfg.harness.value, { prefill: true });
  const h = window.AriaHarnesses.byId(cfg.harness.value);
  if (h && h.detect) detectHarnessSettings(false); // silent auto-detect on pick
});
if (cfg.detectHarness) cfg.detectHarness.addEventListener('click', () => detectHarnessSettings(true));

// --- Remote access (SSH tunnel) ---------------------------------------
// Each input writes its value to the corresponding config key on change;
// the main process picks up the change via CONFIG_SET and calls
// tunnel.sync() (see src/main/index.ts), which starts/stops/restarts
// the SSH tunnel as needed. The Connect/Disconnect buttons send
// explicit TUNNEL_START / TUNNEL_STOP messages; on success the
// supervisor's status stream (TUNNEL_STATUS) updates the dot + label.
// Copy URL copies the tunneled http://127.0.0.1:port/v1/chat/completions
// URL to the clipboard so the user can paste it into the harness/llm
// endpoint field of a "custom" tunnel, or into another tool.
const remoteBindings = [
  ['cfg.remoteEnabled',     'remote.enabled',     'checked'],
  ['cfg.remoteTarget',      'remote.target',      'value'],
  ['cfg.remoteSshHost',     'remote.sshHost',     'value'],
  ['cfg.remoteSshPort',     'remote.sshPort',     'value', parseInt, 22],
  ['cfg.remoteIdentity',    'remote.identityFile', 'value'],
  ['cfg.remoteRemoteHost',  'remote.remoteHost',  'value'],
  ['cfg.remoteRemotePort',  'remote.remotePort',  'value', parseInt, 8080],
  ['cfg.remoteLocalPort',   'remote.localPort',   'value', parseInt, 0],
  ['cfg.remoteAutoReconnect','remote.autoReconnect','checked'],
  ['cfg.remoteRawCommand',  'remote.rawCommand',  'value'],
];
for (const [elKey, cfgKey, prop, parse, fallback] of remoteBindings) {
  const el = cfg[elKey.split('.')[1]];
  if (!el) continue;
  const ev = (el.type === 'checkbox' || el.type === 'radio') ? 'change' : 'input';
  el.addEventListener(ev, () => {
    let v = el[prop];
    if (parse) v = (Number.isFinite(+v) ? parse(v) : fallback);
    aria.config.set(cfgKey, v);
  });
}

// Parse host:port out of an OpenAI-compatible endpoint URL so the SSH tunnel's
// remote host/port can be derived from the harness/LLM endpoint the user already
// configured — they shouldn't have to re-type it. localhost -> 127.0.0.1 (ssh -L
// binds the loopback the remote service listens on).
function parseHostPort(ep) {
  try {
    const u = new URL(ep);
    const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname;
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    if (!host || !Number.isFinite(port)) return null;
    return { host, port };
  } catch (e) { return null; }
}

// Fill the Advanced remote host/port from the selected endpoint and explain, in
// plain words, what the tunnel will do. `adopt` (target just changed) overwrites
// the fields; otherwise we only adopt when they're still at the shipped defaults
// so a power-user's manual Advanced values survive a Settings reopen.
async function syncRemoteDerived(adopt) {
  if (!cfg.remoteTarget) return;
  const info = document.getElementById('remote-derived');
  const target = cfg.remoteTarget.value || 'harness';
  if (target === 'custom') {
    if (info) info.textContent = 'ARIA just opens the local port; paste “Copy URL” into whatever should use it.';
    return;
  }
  const ep = await aria.config.get(target === 'llm' ? 'llm.endpoint' : 'harness.endpoint');
  const hp = parseHostPort(ep);
  const what = target === 'llm' ? 'LLM' : 'harness';
  if (!hp) {
    if (info) info.textContent = `Set your ${what} endpoint first (Providers tab) so ARIA knows what to forward.`;
    return;
  }
  const curHost = cfg.remoteRemoteHost.value;
  const curPort = parseInt(cfg.remoteRemotePort.value, 10);
  const atDefault = (!curHost || curHost === '127.0.0.1') && (!curPort || curPort === 8080);
  if (adopt || atDefault) {
    cfg.remoteRemoteHost.value = hp.host;
    cfg.remoteRemotePort.value = hp.port;
    aria.config.set('remote.remoteHost', hp.host);
    aria.config.set('remote.remotePort', hp.port);
  }
  const usedHost = cfg.remoteRemoteHost.value || hp.host;
  const usedPort = cfg.remoteRemotePort.value || hp.port;
  if (info) info.textContent = `ARIA forwards ${usedHost}:${usedPort} on the remote box to a free local port and points the ${what} at it.`;
}
if (cfg.remoteTarget) cfg.remoteTarget.addEventListener('change', () => syncRemoteDerived(true));

// Render the live tunnel status into the dot + label + endpoint text.
function paintTunnel(s) {
  if (!cfg.tunnelDot || !cfg.tunnelLabel) return;
  const state = s.state || 'idle';
  cfg.tunnelDot.className = 'tunnel-dot ' + state;
  const labelMap = {
    idle: 'idle',
    starting: 'connecting…',
    connected: 'connected',
    reconnecting: `reconnecting (#${s.attempts || 0})`,
    error: 'error',
    stopped: 'stopped',
  };
  cfg.tunnelLabel.textContent = `Tunnel: ${labelMap[state] || state}${s.message ? ' — ' + s.message : ''}`;
  cfg.tunnelEndpoint.textContent = s.endpoint || '';
  cfg.tunnelEndpoint.title = s.endpoint || '';
}
// Subscribe to status pushes and paint on each. The snapshot is fetched
// once on Settings open (see loadSettingsValues below) to back-fill the
// current state before the next status event arrives.
if (aria.tunnel && aria.tunnel.onStatus) {
  aria.tunnel.onStatus(paintTunnel);
}
if (cfg.tunnelConnect) {
  cfg.tunnelConnect.addEventListener('click', () => {
    // Persist the form first (the user might have edited a field and
    // not tabbed out), then trigger start. aria.config.set is async
    // but tunnel.start reads config sync, so we wait for the form
    // write to settle via a microtask before starting.
    Promise.all(remoteBindings.map(([elKey, cfgKey, prop, parse, fallback]) => {
      const el = cfg[elKey.split('.')[1]];
      if (!el) return Promise.resolve();
      let v = el[prop];
      if (parse) v = (Number.isFinite(+v) ? parse(v) : fallback);
      return aria.config.set(cfgKey, v);
    })).then(() => aria.tunnel.start());
  });
}
if (cfg.tunnelDisconnect) {
  cfg.tunnelDisconnect.addEventListener('click', () => aria.tunnel.stop());
}
if (cfg.tunnelCopyUrl) {
  cfg.tunnelCopyUrl.addEventListener('click', () => {
    const url = cfg.tunnelEndpoint.textContent || '';
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url);
    } else {
      // Fallback for sandboxed renderers without clipboard access.
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    }
  });
}

// --- Performance panel: live per-stage latency + hardware-adaptive GPU cap ---
const perfEls = {
  firstAudio: document.getElementById('perf-first-audio'),
  stt: document.getElementById('perf-stt'),
  llm: document.getElementById('perf-llm'),
  llmLabel: document.getElementById('perf-llm-label'),
  tts: document.getElementById('perf-tts'),
  total: document.getElementById('perf-total'),
  hw: document.getElementById('perf-hw'),
};

function fmtMs(v) {
  if (v === null || v === undefined) return '—';
  return v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms';
}

// Paint the most-recent turn's per-stage timings into the panel. Cheap; called
// on every perf mark (live) but only does work while the panel is visible.
function refreshPerfPanel() {
  if (!perfEls.total || !settingsOverlay.classList.contains('visible')) return;
  const s = perf.lastStages();
  if (!s) {
    perfEls.firstAudio.textContent = perfEls.stt.textContent = perfEls.llm.textContent = '—';
    perfEls.tts.textContent = perfEls.total.textContent = '—';
    return;
  }
  perfEls.firstAudio.textContent = fmtMs(s.firstAudio);
  perfEls.stt.textContent = fmtMs(s.stt);
  perfEls.llm.textContent = fmtMs(s.llm);
  perfEls.tts.textContent = fmtMs(s.tts);
  perfEls.total.textContent = fmtMs(s.total);
  perfEls.llmLabel.textContent = s.target ? '· LLM / Agent · ' + s.target : '· LLM / Agent';
  // Flag a slow time-to-first-audio (what the user feels) and a slow LLM stage in
  // the warning colour so the bottleneck is obvious at a glance.
  perfEls.firstAudio.classList.toggle('warn', typeof s.firstAudio === 'number' && s.firstAudio >= 2000);
  perfEls.llm.classList.toggle('warn', typeof s.llm === 'number' && s.llm >= 2500);
}
try { perf.onUpdate(() => refreshPerfPanel()); } catch (e) {}

// Detected hardware + adaptive profile (from the main process). Cached per cap.
async function loadHardwareInfo() {
  try { return await aria.hardware.info(); } catch (e) { return null; }
}
function renderHardware(info) {
  if (!info || !perfEls.hw) return;
  const hw = info.hardware, p = info.profile;
  const vram = hw.gpu.vramMB ? (Math.round(hw.gpu.vramMB / 1024 * 10) / 10) + ' GB VRAM' : 'VRAM n/a';
  // textContent (not innerHTML) — the GPU name comes from system tools; never
  // interpolate it into markup. .perf-hw uses white-space: pre-line for the breaks.
  perfEls.hw.textContent =
    `Detected: ${hw.tier} tier · ${hw.cpuCores} cores · ${hw.totalMemGB} GB RAM\n` +
    `GPU: ${hw.gpu.name} (${vram})\n` +
    `Adapting: orb ${p.orbQuality} quality · STT ${p.sttThreads} threads (${p.sttBackend}) · cap ${p.gpuCapPct}%`;
}
// Push the profile's orb quality into the renderer so the orb's GPU work is
// bounded by the cap — called at startup and whenever the cap changes.
function applyOrbQuality(info) {
  const q = info && info.profile && info.profile.orbQuality;
  if (q && window.AriaOrb && window.AriaOrb.setQuality) window.AriaOrb.setQuality(q);
}

// Bound the orb from the very first frame, before Settings is ever opened.
loadHardwareInfo().then((info) => applyOrbQuality(info));

// Resource preset descriptions (mirrors hardware.ts PERF_PRESETS).
const PRESET_HINTS = {
  'auto': 'Detects your hardware and picks the fastest settings it can run smoothly.',
  'power-saver': 'Smallest models, CPU-only, minimal GPU — runs light on any machine.',
  'balanced': 'Fast speech-to-text + the natural Kokoro voice at moderate resource use.',
  'max-performance': 'Largest models your hardware allows, full GPU, best accuracy & voice.',
  'custom': 'Your own manual choices (set automatically when you change a setting below).',
};
function updatePresetHint() {
  const el = document.getElementById('perf-preset-hint');
  if (el && cfg.perfPreset) el.textContent = PRESET_HINTS[cfg.perfPreset.value] || '';
}

// Picking a resource preset applies live: the main process writes the whole
// bundle (STT model/backend, TTS engine/voice, GPU cap) and reloads the sidecars,
// so we re-read Settings to reflect the new values, re-derive the orb quality, and
// refresh the hardware readout. This is what makes a preset visibly DO something.
if (cfg.perfPreset) {
  cfg.perfPreset.addEventListener('change', async () => {
    await aria.config.set('ui.perfPreset', cfg.perfPreset.value);
    updatePresetHint();
    // 'custom' applies nothing; for a real preset, pull the resolved settings back
    // into the STT/TTS/etc. controls so the user sees them change.
    if (cfg.perfPreset.value !== 'custom') await loadSettings();
    const info = await loadHardwareInfo();
    applyOrbQuality(info);
    renderHardware(info);
  });
}

// --- In-app updates (see src/main/updater.ts) ---
const upd = {
  version: document.getElementById('update-version'),
  checkBtn: document.getElementById('update-check-btn'),
  actionBtn: document.getElementById('update-action-btn'),
  status: document.getElementById('update-status'),
  channelHint: document.getElementById('update-channel-hint'),
  progress: document.getElementById('update-progress'),
  banner: document.getElementById('update-banner'),
  bannerText: document.getElementById('update-banner-text'),
  bannerAction: document.getElementById('update-banner-action'),
  bannerDismiss: document.getElementById('update-banner-dismiss'),
};
let updateChannel = 'dev';

(async function initUpdatesUi() {
  try {
    const info = await aria.updates.current();
    updateChannel = info.channel;
    upd.version.textContent = info.version;
    upd.channelHint.textContent =
      info.channel === 'appimage' ? 'Auto-updates are enabled — a new release downloads in the background and installs on your click.'
      : info.channel === 'deb' ? 'One-click updates are enabled — ARIA downloads the new release and installs it after you approve a password prompt, then restarts.'
      : 'Development build — update checks compare against the latest GitHub release.';
  } catch (e) { /* bridge unavailable */ }
})();

function setUpdateStatus(text, cls) {
  if (!upd.status) return;
  upd.status.textContent = text || ' ';
  upd.status.className = cls || '';
}
function showActionBtn(label, handler) {
  upd.actionBtn.textContent = label;
  upd.actionBtn.style.display = '';
  upd.actionBtn.onclick = handler;
}
function hideActionBtn() { upd.actionBtn.style.display = 'none'; upd.actionBtn.onclick = null; }

// Drive the update progress bar so the user can see a download/install actually
// moving instead of wondering whether it stalled.
//   'hide'          -> no bar
//   'indeterminate' -> animated sweep (checking / installing, no percent yet)
//   <number 0..100> -> determinate fill at that percent (downloading)
function setUpdateProgress(state) {
  const p = upd.progress;
  if (!p) return;
  if (state === 'hide' || state == null) { p.style.display = 'none'; return; }
  p.style.display = '';
  if (state === 'indeterminate') {
    p.classList.add('indeterminate');
    p.removeAttribute('value');
  } else {
    p.classList.remove('indeterminate');
    p.value = Math.max(0, Math.min(100, Number(state) || 0));
  }
}

let updateBannerDismissed = false;
function showUpdateBanner(text, actionLabel, handler) {
  if (updateBannerDismissed) return;
  upd.bannerText.textContent = text;
  if (actionLabel) {
    upd.bannerAction.textContent = actionLabel;
    upd.bannerAction.style.display = '';
    upd.bannerAction.onclick = handler;
  } else {
    upd.bannerAction.style.display = 'none';
  }
  upd.banner.classList.add('visible');
}
upd.bannerDismiss.addEventListener('click', () => { updateBannerDismissed = true; upd.banner.classList.remove('visible'); });

upd.checkBtn.addEventListener('click', () => {
  updateBannerDismissed = false; // an explicit check should be allowed to re-banner
  setUpdateStatus('Checking for updates…');
  hideActionBtn();
  aria.updates.check();
});

aria.updates.onStatus((s) => {
  const v = s.version ? 'v' + s.version : '';
  switch (s.state) {
    case 'checking':
      setUpdateStatus('Checking for updates…'); hideActionBtn(); setUpdateProgress('hide'); break;
    case 'not-available':
      setUpdateStatus(`You're on the latest version (v${s.current}).`, 'ok'); hideActionBtn(); setUpdateProgress('hide'); break;
    case 'available':
      if (s.canAutoInstall && updateChannel === 'appimage') {
        // AppImage downloads automatically in the background.
        setUpdateStatus(`${v} found — downloading…`); hideActionBtn();
        showUpdateBanner(`ARIA ${v} is available and downloading…`, null);
        setUpdateProgress('indeterminate'); // download starting; percent arrives next
      } else if (s.canAutoInstall) {
        // .deb: one-click Update (downloads, verifies, installs via a password
        // prompt, and restarts). View release stays as a manual fallback.
        setUpdateStatus(`${v} is available.`, 'ok');
        showActionBtn('Update', () => aria.updates.install());
        upd.releaseUrl = s.url;
        showUpdateBanner(`ARIA ${v} is available.`, 'Update', () => aria.updates.install());
        setUpdateProgress('hide'); // nothing downloading until the user clicks Update
      } else {
        setUpdateStatus(`${v} is available.`, 'ok');
        showActionBtn('View release', () => aria.updates.openRelease(s.url));
        showUpdateBanner(`ARIA ${v} is available.`, 'View release', () => aria.updates.openRelease(s.url));
        setUpdateProgress('hide');
      }
      break;
    case 'downloading': {
      // Show a moving bar so the user can see the download progressing instead of
      // wondering if it hung. The banner is the always-visible surface; surface it
      // here for every channel (the deb path only emits 'downloading' after the
      // user clicks Update, so this won't pop unprompted).
      const pct = s.percent != null ? s.percent + '%' : '';
      const label = v || 'the update';
      setUpdateStatus(`Downloading ${v}… ${pct}`); hideActionBtn();
      showUpdateBanner(`Downloading ARIA ${label}… ${pct}`, null);
      setUpdateProgress(s.percent != null ? s.percent : 'indeterminate');
      break;
    }
    case 'downloaded':
      setUpdateStatus(`${v} downloaded.`, 'ok'); setUpdateProgress('hide');
      // AppImage waits for an explicit Install & Restart; .deb proceeds to install.
      if (updateChannel === 'appimage') {
        showActionBtn('Install & Restart', () => aria.updates.install());
        showUpdateBanner(`ARIA ${v} is ready.`, 'Install & Restart', () => aria.updates.install());
      } else { hideActionBtn(); }
      break;
    case 'installing':
      setUpdateStatus(`Installing ${v}… approve the password prompt.`); hideActionBtn();
      showUpdateBanner(`Installing ARIA ${v}…`, null);
      setUpdateProgress('indeterminate'); // install has no percent — keep it moving
      break;
    case 'installed':
      setUpdateStatus(`${v} installed — restarting…`, 'ok'); hideActionBtn();
      showUpdateBanner(`ARIA ${v} installed — restarting…`, null);
      setUpdateProgress('hide');
      break;
    case 'error':
      setUpdateStatus(`Update failed: ${s.message || 'unknown error'}`, 'warn');
      setUpdateProgress('hide');
      // Offer the manual fallback when we have a release URL.
      if (upd.releaseUrl) showActionBtn('View release', () => aria.updates.openRelease(upd.releaseUrl));
      else hideActionBtn();
      break;
  }
});

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
  if (cfg.ttsSpeed) {
    const sp = await aria.config.get('tts.speed');
    cfg.ttsSpeed.value = (typeof sp === 'number' ? sp : 1.0);
    if (cfg.ttsSpeedVal) cfg.ttsSpeedVal.textContent = parseFloat(cfg.ttsSpeed.value).toFixed(2) + '×';
  }
  if (cfg.volume) {
    const vol = await aria.config.get('audio.volume');
    cfg.volume.value = (typeof vol === 'number' ? vol : 1.0);
    if (cfg.volumeVal) cfg.volumeVal.textContent = Math.round(cfg.volume.value * 100) + '%';
  }
  cfg.wwEnabled.checked = !!(await aria.config.get('wakeword.enabled'));
  cfg.wwPhrase.value = (await aria.config.get('wakeword.phrase')) || 'hey_jarvis';
  if (cfg.conversationEnabled) cfg.conversationEnabled.checked = !!(await aria.config.get('conversation.enabled'));
  // Legacy/free-text values (e.g. "hey jarvis" with a space, or an unsupported
  // "aria") won't match a dropdown option -> fall back to the reliable default so
  // the control never shows blank and always reflects a model that actually loads.
  if (cfg.wwPhrase.selectedIndex < 0) cfg.wwPhrase.value = 'hey_jarvis';
  cfg.theme.value = (await aria.config.get('ui.theme')) || 'midnight';
  if (cfg.perfPreset) { cfg.perfPreset.value = (await aria.config.get('ui.perfPreset')) || 'auto'; updatePresetHint(); }

  // Remote access: back-fill the form from the current config + paint the
  // current tunnel status so the user sees "connected" / "error" before
  // the next push event.
  if (cfg.remoteEnabled) {
    cfg.remoteEnabled.checked       = !!(await aria.config.get('remote.enabled'));
    cfg.remoteTarget.value          = (await aria.config.get('remote.target')) || 'harness';
    cfg.remoteSshHost.value         = (await aria.config.get('remote.sshHost')) || '';
    cfg.remoteSshPort.value         = (await aria.config.get('remote.sshPort')) || 22;
    cfg.remoteIdentity.value        = (await aria.config.get('remote.identityFile')) || '';
    cfg.remoteRemoteHost.value      = (await aria.config.get('remote.remoteHost')) || '127.0.0.1';
    cfg.remoteRemotePort.value      = (await aria.config.get('remote.remotePort')) || 8080;
    cfg.remoteLocalPort.value       = (await aria.config.get('remote.localPort')) || 0;
    cfg.remoteAutoReconnect.checked = !!(await aria.config.get('remote.autoReconnect'));
    cfg.remoteRawCommand.value      = (await aria.config.get('remote.rawCommand')) || '';
    await syncRemoteDerived(false); // fill remote host/port from the endpoint + explain
    if (aria.tunnel && aria.tunnel.snapshot) {
      try { paintTunnel(await aria.tunnel.snapshot()); } catch (e) { /* ignore */ }
    }
  }

  // Performance panel: show the latest turn's latency + detected hardware.
  refreshPerfPanel();
  loadHardwareInfo().then((info) => { renderHardware(info); applyOrbQuality(info); });

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
  // The hardware readout was only rendered on preset *change*, so the panel
  // sat on "Detecting hardware…" forever — render it on every open.
  loadHardwareInfo().then((info) => renderHardware(info));
  settingsOverlay.classList.add('visible');
}
async function closeSettings() {
  settingsOverlay.classList.remove('visible');
  // Revert any unsaved live theme preview to the persisted theme.
  applyTheme((await aria.config.get('ui.theme')) || 'midnight');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);

// New session: stop anything in flight, wipe the on-screen transcript AND the
// main-side conversation history, and return to a clean idle state.
const newSessionBtn = document.getElementById('new-session-btn');
if (newSessionBtn) {
  newSessionBtn.addEventListener('click', () => {
    bargeIn();                          // cancel gen + stop audio + clear stream/tool state
    try { aria.llm.reset(); } catch (e) {} // clear history on the main side
    conversationEl.replaceChildren();   // empty transcript -> :empty placeholder returns
    partialEl.textContent = '';
    currentAssistantMsg = null;
    lastTurnWasVoice = false;
    orbState('idle');
  });
}
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

// --- Past conversations (history) -----------------------------------------
// Sessions are persisted in the main process (src/main/sessions.ts). This
// overlay lists them newest-first and shows the read-only transcript of the one
// you click. Reuses the .message bubble styles from the live conversation.
const historyOverlay = document.getElementById('history-overlay');
const historyBtn = document.getElementById('history-btn');
const historyClose = document.getElementById('history-close');
const historyListEl = document.getElementById('history-list');
const historyTranscriptEl = document.getElementById('history-transcript');
const historyViewTitle = document.getElementById('history-view-title');
const historyDeleteBtn = document.getElementById('history-delete');
let historySelectedId = null;

function relTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  const d = Math.floor(s / 86400);
  return d < 7 ? d + 'd ago' : new Date(ts).toLocaleDateString();
}

async function refreshHistoryList() {
  let list = [];
  try { list = await aria.sessions.list(); } catch (e) {}
  historyListEl.replaceChildren();
  if (!list || !list.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No past conversations yet.';
    historyListEl.appendChild(empty);
    return;
  }
  for (const s of list) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'history-item' + (s.id === historySelectedId ? ' active' : '');
    const t = document.createElement('div'); t.className = 'h-title'; t.textContent = s.title;
    const m = document.createElement('div'); m.className = 'h-meta';
    m.textContent = `${relTime(s.updatedAt)} · ${s.turns} message${s.turns === 1 ? '' : 's'}`;
    item.append(t, m);
    item.addEventListener('click', () => showHistorySession(s.id));
    historyListEl.appendChild(item);
  }
}

async function showHistorySession(id) {
  historySelectedId = id;
  await refreshHistoryList(); // repaint the active highlight
  let rec = null;
  try { rec = await aria.sessions.get(id); } catch (e) {}
  historyTranscriptEl.replaceChildren();
  if (!rec) { historyViewTitle.textContent = 'Conversation not found'; historyDeleteBtn.hidden = true; return; }
  historyViewTitle.textContent = rec.title || 'Conversation';
  historyDeleteBtn.hidden = false;
  for (const turn of rec.turns) {
    const div = document.createElement('div');
    div.className = `message ${turn.role}`;
    div.textContent = turn.content;
    historyTranscriptEl.appendChild(div);
  }
}

async function openHistory() {
  historySelectedId = null;
  historyDeleteBtn.hidden = true;
  historyViewTitle.textContent = 'Past conversations';
  historyTranscriptEl.replaceChildren();
  await refreshHistoryList();
  historyOverlay.classList.add('visible');
}
function closeHistory() { historyOverlay.classList.remove('visible'); }

if (historyBtn) historyBtn.addEventListener('click', openHistory);
if (historyClose) historyClose.addEventListener('click', closeHistory);
if (historyDeleteBtn) {
  historyDeleteBtn.addEventListener('click', async () => {
    if (!historySelectedId) return;
    try { await aria.sessions.delete(historySelectedId); } catch (e) {}
    historySelectedId = null;
    historyDeleteBtn.hidden = true;
    historyViewTitle.textContent = 'Past conversations';
    historyTranscriptEl.replaceChildren();
    await refreshHistoryList();
  });
}
if (historyOverlay) {
  historyOverlay.addEventListener('click', (e) => { if (e.target === historyOverlay) closeHistory(); });
}

// Settings tabs: the left nav swaps which .tab-panel is visible and updates the
// header title. Pure DOM toggle — no per-tab state to persist.
const settingsNav = document.getElementById('settings-nav');
const settingsTabTitle = document.getElementById('settings-tab-title');
if (settingsNav) {
  const navItems = settingsNav.querySelectorAll('.snav-item');
  const panels = document.querySelectorAll('.settings-content .tab-panel');
  const content = document.querySelector('.settings-content');
  function showTab(tab) {
    navItems.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
    const active = settingsNav.querySelector('.snav-item.active');
    // lastChild is the label text node after the .snav-ico emoji span — use it so
    // the header title reads "Voice", not "🎙Voice".
    if (active && settingsTabTitle) settingsTabTitle.textContent = (active.lastChild && active.lastChild.textContent || active.textContent).trim();
    if (content) content.scrollTop = 0;
  }
  navItems.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
}

// "Discover model" buttons — probe the configured endpoint for its served
// model list via IPC and pre-fill the model field with the recommended id. The
// endpoint URL + key are pulled from the form (NOT from persisted config) so a
// pasted URL is tested before the user hits Save. Status shown under the row:
// success -> green preview-list; failure -> red error text. Never persists.
async function discoverModel(kind) {
  const endpointEl = kind === 'llm' ? cfg.llmEndpoint : cfg.harnessEndpoint;
  const modelEl    = kind === 'llm' ? cfg.llmModel    : cfg.harnessModel;
  const keyEl      = kind === 'llm' ? cfg.llmKey      : cfg.harnessKey;
  const btn        = kind === 'llm' ? cfg.discoverLlm : cfg.discoverHarness;
  const statusEl   = kind === 'llm' ? cfg.discoverLlmStatus : cfg.discoverHarnessStatus;
  const endpoint = (endpointEl.value || '').trim();
  if (!endpoint) {
    statusEl.textContent = 'Enter an endpoint URL first.';
    statusEl.className = 'err';
    return;
  }
  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Discovering…';
  statusEl.textContent = '';
  statusEl.className = '';
  try {
    const r = await aria.llm.listModels({ endpoint, apiKey: keyEl.value });
    if (!r.ok) {
      statusEl.textContent = 'Failed: ' + (r.error || 'unknown error');
      statusEl.className = 'err';
      return;
    }
    if (!r.models || r.models.length === 0) {
      statusEl.textContent = 'Endpoint reachable but returned no models — enter one manually.';
      statusEl.className = 'err';
      return;
    }
    // Pre-fill the input with the recommended id (if not already filled).
    if (!modelEl.value && r.recommended) modelEl.value = r.recommended;
    const preview = r.models.slice(0, 6).join(', ');
    const more = r.models.length > 6 ? `, … (+${r.models.length - 6} more)` : '';
    statusEl.textContent = `Found ${r.models.length} model${r.models.length === 1 ? '' : 's'}: ${preview}${more}`;
    statusEl.className = 'ok';
  } catch (e) {
    statusEl.textContent = 'Discovery error: ' + (e && e.message ? e.message : String(e));
    statusEl.className = 'err';
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}
if (cfg.discoverLlm)     cfg.discoverLlm.addEventListener('click',     () => discoverModel('llm'));
if (cfg.discoverHarness) cfg.discoverHarness.addEventListener('click', () => discoverModel('harness'));

settingsSave.addEventListener('click', async () => {
  await aria.config.set('routing.mode', cfg.routingMode.value);
  await aria.config.set('llm.endpoint', cfg.llmEndpoint.value.trim());
  await aria.config.set('llm.model', cfg.llmModel.value.trim());
  await aria.config.set('harness.id', cfg.harness.value);
  await aria.config.set('harness.endpoint', cfg.harnessEndpoint.value.trim());
  await aria.config.set('harness.model', cfg.harnessModel.value.trim());
  await aria.config.set('stt.model', cfg.sttModel.value);
  await aria.config.set('stt.backend', cfg.sttBackend.value);
  // Derive the TTS engine from the chosen voice: Kokoro voices are af_/am_/bf_/bm_;
  // anything else (e.g. en_US-lessac-medium) is a Piper voice.
  const ttsVoice = cfg.ttsVoice.value.trim();
  await aria.config.set('tts.engine', /^(af_|am_|bf_|bm_)/.test(ttsVoice) ? 'kokoro' : 'piper');
  await aria.config.set('tts.voice', ttsVoice);
  await aria.config.set('wakeword.enabled', cfg.wwEnabled.checked);
  await aria.config.set('wakeword.phrase', cfg.wwPhrase.value.trim());
  if (cfg.conversationEnabled) {
    conversationMode = cfg.conversationEnabled.checked;
    await aria.config.set('conversation.enabled', conversationMode);
  }
  await aria.config.set('ui.theme', cfg.theme.value);
  applyTheme(cfg.theme.value);
  // The GPU cap is preset-driven (no separate control). Manually editing the STT
  // model / backend / TTS voice above flips the active preset to 'custom' in main;
  // re-read it so the Resource-usage dropdown reflects that.
  if (cfg.perfPreset) { cfg.perfPreset.value = (await aria.config.get('ui.perfPreset')) || 'auto'; updatePresetHint(); }
  // A changed STT model/backend may not be downloaded yet + needs a sidecar
  // reload; that's handled in main. Re-derive the orb quality from the (possibly
  // preset-changed) GPU cap so the orb matches what was saved.
  loadHardwareInfo().then((info) => applyOrbQuality(info));

  // Persist exactly what's in the key fields (they stay populated, not cleared).
  const lk = cfg.llmKey.value.trim();
  lk ? await aria.secure.set('llm-api-key', lk) : await aria.secure.delete('llm-api-key');
  const hk = cfg.harnessKey.value.trim();
  hk ? await aria.secure.set('harness-api-key', hk) : await aria.secure.delete('harness-api-key');

  savedMsg.textContent = 'Saved ✓';
  setTimeout(() => { savedMsg.textContent = ''; }, 2500);
  updateChatSub();
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
  detect: document.getElementById('onb-detect'),
  detectStatus: document.getElementById('onb-detect-status'),
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
  // Local servers (Ollama/LM Studio/vLLM) ignore the key — say so explicitly.
  onb.llmKey.placeholder = p.local ? 'not required for local servers' : (p.keyHint || 'optional');
  onb.llmEndpoint.value = p.endpoint || '';
  onb.llmModel.value = p.defaultModel || '';
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
  if (onb.detect) onb.detect.hidden = !h.detect;
  if (!h.detect && onb.detectStatus) onb.detectStatus.textContent = '';
}
function onbDetect(force) {
  return detectHarnessInto(onb.harness.value, {
    endpointEl: onb.endpoint, modelEl: onb.model, keyEl: onb.key, statusEl: onb.detectStatus,
  }, { force });
}
onb.harness.addEventListener('change', () => {
  onbApplyHarness();
  const h = onbSelectedHarness();
  if (h && h.detect) onbDetect(false); // silent auto-detect on pick; key shows on step 2
});
if (onb.detect) onb.detect.addEventListener('click', () => onbDetect(true));

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
