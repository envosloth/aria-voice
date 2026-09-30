#!/usr/bin/env node
// Live renderer check for voice barge-in wiring (conversation.voiceBargeIn).
// Boots the built app with an isolated profile, then in the real renderer:
//   - the Settings checkbox saves/loads conversation.voiceBargeIn;
//   - with the setting ON and ARIA "speaking", echo-only mic frames do not
//     interrupt, and the user's voice over it opens a hands-free utterance with
//     a bounded PCM pre-roll;
//   - with the setting OFF, or when ARIA is not speaking, nothing fires.
// Chromium's fake capture device drives the real mic graph, so the renderer's
// frame handler reaches checkVoiceBargeIn(). A CDP breakpoint there pauses
// inside the app's closure; the scenario then runs via evaluateOnCallFrame
// against the shipped functions (TTS analyser stubbed) — no production test hook.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-barge-'));
const electron = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(port) {
  const child = spawn(electron, ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    path.join(root, 'dist', 'main', 'index.js')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData,
      XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}
async function connect(port) {
  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
    try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && /index\.html/.test(x.url)); } catch (e) {}
    if (!t) await sleep(250);
  }
  if (!t) throw new Error('renderer not reachable');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  const events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method) events.push(d); };
  const send = (method, params) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 400)); return d.result.result.value; });
  return { ws, ev, send, events };
}

(async () => {
  let ok = false; let child = null;
  try {
    const port = 9800 + Math.floor(Math.random() * 150);
    child = boot(port);
    const { ws, ev, send, events } = await connect(port);
    await sleep(1500);
    const r = await ev(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelectorAll('#onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      const out = {};
      out.defaultOn = (await aria.config.get('conversation.voiceBargeIn')) === true;
      document.getElementById('settings-btn').click();
      await wait(300);
      const box = document.getElementById('cfg-voice-barge-in');
      out.checkboxPresent = !!box && !!box.closest('label');
      box.checked = true;
      document.getElementById('settings-save').click();
      await wait(600);
      out.saved = (await aria.config.get('conversation.voiceBargeIn')) === true;
      return out;
    })()`);

    // Pause inside checkVoiceBargeIn on a real fake-mic frame.
    const appSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8').split('\n');
    const line = appSrc.findIndex((l) => /const playing = speechActive && ttsSources\.length > 0 && !listening;/.test(l));
    if (line < 0) throw new Error('checkVoiceBargeIn body not found');
    await send('Debugger.enable', {});
    const bp = await send('Debugger.setBreakpointByUrl', { urlRegex: 'renderer/app\\.js$', lineNumber: line });
    let paused = null;
    for (let i = 0; i < 100 && !paused; i++) { paused = events.find((e) => e.method === 'Debugger.paused'); if (!paused) await sleep(100); }
    if (!paused) throw new Error('mic frame never reached checkVoiceBargeIn (fake capture device not flowing)');
    r.micFramesReachDetector = true;
    await send('Debugger.removeBreakpoint', { breakpointId: bp.result.breakpointId });
    const scenario = `(() => {
      const out = { liveFlag: voiceBargeIn === true };
      const calls = [];
      beginUtterance = (opts) => { calls.push(opts); };
      let refAmp = 0;
      ttsAnalyser = { getFloatTimeDomainData: (buf) => { for (let i = 0; i < buf.length; i++) buf[i] = refAmp * Math.SQRT2 * Math.sin(i / 7); } };
      ttsGain = null;
      const frame = (amp) => { const s = new Float32Array(960); for (let i = 0; i < s.length; i++) s[i] = amp * Math.SQRT2 * Math.sin(i / 5); return s; };
      const feed = (n, micFn, refFn) => { for (let i = 0; i < n; i++) { refAmp = refFn(i); const s = frame(micFn(i)); checkVoiceBargeIn(s, window.AriaAudio.micFrameToPcm16k(s, 48000)); } };
      const speaking = () => { speechActive = true; ttsSources = [{}]; listening = false; };
      const env = (i) => 0.2 + 0.1 * Math.sin(i / 3);
      speaking();
      feed(150, (i) => 0.4 * env(i), env);
      out.echoOnlyCalls = calls.length;
      feed(20, (i) => 0.4 * env(i) + 0.3, env);
      out.userCalls = calls.length;
      out.opts = calls[0] ? { vad: calls[0].vad, soft: calls[0].soft, prerollLen: calls[0].preroll.length,
        prerollIsBuffer: calls[0].preroll.every((p) => p instanceof ArrayBuffer || ArrayBuffer.isView(p)) } : null;
      calls.length = 0; speechActive = false; ttsSources = [];
      feed(60, () => 0.5, () => 0);
      out.idleCalls = calls.length;
      voiceBargeIn = false; speaking();
      feed(60, () => 0.5, () => 0.05);
      out.offCalls = calls.length;
      speechActive = false; ttsSources = [];
      voiceBargeIn = true;
      return JSON.stringify(out);
    })()`;
    // Pause-and-decide, against the real functions (no hook): a barge-in
    // pauses the reply; the transcript of that moment resumes or stops it.
    const soft = `(() => {
      const out = {}; softBarge = null;
      const suspends = []; let ctxState = 'running';
      audioCtx = { get state() { return ctxState; }, currentTime: 0,
        suspend() { suspends.push('suspend'); ctxState = 'suspended'; return Promise.resolve(); },
        resume() { suspends.push('resume'); ctxState = 'running'; return Promise.resolve(); } };
      const utterances = []; const submitted = []; let cancelled = 0; const aborted = [];
      beginUtterance = (opts) => { utterances.push(opts); listening = true; currentVoiceTurnId = 'voice-soft-' + utterances.length; };
      submitUserMessage = (text) => { submitted.push(text); };
      aria.llm.cancel = () => { cancelled++; };
      const stop = { called: 0 }; const realStop = stopPlayback;
      const says = 'Flights from Denver to Cairo are the biggest cost, about thirteen hundred dollars each round trip.';
      const reply = (turn) => { speechActive = true; ttsSources = [{ stop() { aborted.push(turn); } }]; listening = false; spokenSoFar = says; ttsSynthDone = false; orbStateName = 'speaking'; };
      const result = (text) => { listening = false; window.__stt(text, currentVoiceTurnId); };
      // 1. Echo-only burst: paused, nobody spoke, resumed where it was.
      reply('a'); startSoftBarge([]);
      out.pausedOnDetect = ctxState === 'suspended' && utterances.length === 1 && utterances[0].soft === true && cancelled === 0 && aborted.length === 0;
      resumeFromSoftBarge();
      out.resumedAfterSilence = ctxState === 'running' && speechActive && aborted.length === 0 && cancelled === 0 && orbStateName === 'speaking';
      // 2. STT heard ARIA's own words: resume, nothing submitted.
      reply('b'); startSoftBarge([]);
      out.echoWordsResume = settleSoftBarge('about thirteen hundred dollars each', 'voice-x') === true && ctxState === 'running' && submitted.length === 0 && aborted.length === 0;
      // 3. Real words: not handled here, so the normal path stops the reply.
      reply('c'); startSoftBarge([]);
      out.realWordsInterrupt = settleSoftBarge('wait what about hotels in Luxor', 'voice-y') === false && !!softBarge;
      stopPlayback(false);
      out.stopClearsPause = softBarge === null && ctxState === 'running' && aborted.includes('c');
      // 4. The pause never plays the chime or re-opens a hands-free wake turn.
      reply('d'); startSoftBarge([]); const before = utterances.length; startSoftBarge([]);
      out.singlePause = utterances.length === before;
      softBarge = null; speechActive = false; ttsSources = []; listening = false;
      return JSON.stringify(out);
    })()`;
    const res = await send('Debugger.evaluateOnCallFrame', { callFrameId: paused.params.callFrames[0].callFrameId, expression: scenario, returnByValue: true });
    if (res.result.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400));
    Object.assign(r, JSON.parse(res.result.result.value));
    const res2 = await send('Debugger.evaluateOnCallFrame', { callFrameId: paused.params.callFrames[0].callFrameId, expression: soft, returnByValue: true });
    if (res2.result.exceptionDetails) throw new Error(JSON.stringify(res2.result.exceptionDetails).slice(0, 400));
    Object.assign(r, JSON.parse(res2.result.result.value));
    await send('Debugger.resume', {});
    ws.close();
    console.log(JSON.stringify(r, null, 2));
    const checks = {
      defaultOn: r.defaultOn,
      settingsCheckbox: r.checkboxPresent,
      settingsSaves: r.saved && r.liveFlag,
      micFramesReachDetector: r.micFramesReachDetector === true,
      echoDoesNotInterrupt: r.echoOnlyCalls === 0,
      userInterruptsOnce: r.userCalls === 1,
      handsFreeWithPreroll: !!r.opts && r.opts.vad === true && r.opts.soft === true && r.opts.prerollLen > 0 && r.opts.prerollLen <= 16 && r.opts.prerollIsBuffer,
      pausesNotCancels: r.pausedOnDetect === true,
      resumesAfterSilence: r.resumedAfterSilence === true,
      echoWordsResume: r.echoWordsResume === true,
      realWordsInterrupt: r.realWordsInterrupt === true,
      stopClearsPause: r.stopClearsPause === true,
      singlePause: r.singlePause === true,
      idleNeverFires: r.idleCalls === 0,
      disabledNeverFires: r.offCalls === 0,
    };
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    ok = Object.values(checks).every(Boolean);
  } catch (e) {
    console.error('[barge-live] error:', e.message);
  } finally {
    if (child) { child.kill('SIGTERM'); await sleep(800); try { child.kill('SIGKILL'); } catch (e) {} }
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(`\n=== RESULT: ${ok ? 'PASS' : 'FAIL'} ===`);
  process.exit(ok ? 0 : 1);
})();
