#!/usr/bin/env node
// Live check: Settings → Voice → Text-to-Speech has separate Engine and Voice
// choices. The voice list follows the engine, the chosen pair is saved, it
// survives reopening Settings, and the voice really plays after a switch.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-ttsui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let ok = false; let child = null; let log = '';
  try {
    const port = 9300 + Math.floor(Math.random() * 90);
    child = spawn(require('electron'), ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
      path.join(root, 'dist', 'main', 'index.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERMES_HOME: path.join(userData, 'nh'), ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData,
        XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
    });
    child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
    let t = null;
    for (let i = 0; i < 80 && !t; i++) {
      try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && /index\.html/.test(x.url)); } catch (e) {}
      if (!t) await sleep(250);
    }
    if (!t) throw new Error('renderer not reachable');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
    const ev = (expr) => new Promise((r) => { const n = ++id; pend.set(n, r);
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
      .then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 400)); return d.result.result.value; });
    await sleep(1500);
    const r = await ev(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelectorAll('#onboard-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      const open = async () => {
        document.getElementById('settings-btn').click(); await wait(400);
        document.querySelector('#settings-nav .snav-item[data-tab="voice"]').click(); await wait(200);
      };
      const eng = () => document.getElementById('cfg-tts-engine');
      const voice = () => document.getElementById('cfg-tts-voice');
      const voices = () => [...voice().options].map(o => o.value);
      const out = {};
      await open();
      out.engines = [...eng().options].map(o => o.value);
      out.startEngine = eng().value; out.startVoice = voice().value;
      eng().value = 'kokoro'; eng().dispatchEvent(new Event('change'));
      out.kokoroVoices = voices(); out.kokoroHint = document.getElementById('cfg-tts-engine-hint').textContent;
      voice().value = 'bf_emma'; voice().dispatchEvent(new Event('change'));
      eng().value = 'piper'; eng().dispatchEvent(new Event('change'));
      out.piperVoices = voices(); out.piperDefault = voice().value;
      eng().value = 'kokoro'; eng().dispatchEvent(new Event('change'));
      out.rememberedKokoro = voice().value;          // back to Emma, not the default
      document.getElementById('settings-save').click(); await wait(800);
      out.savedEngine = await aria.config.get('tts.engine');
      out.savedVoice = await aria.config.get('tts.voice');
      document.getElementById('settings-close').click(); await wait(400);
      await open();
      out.reopenEngine = eng().value; out.reopenVoice = voice().value;
      // Tamper: a mismatched pair in config must be shown sanely (engine wins).
      await aria.config.set('tts.engine', 'piper'); await aria.config.set('tts.voice', 'bm_george');
      document.getElementById('settings-close').click(); await wait(300);
      await open();
      out.mismatchEngine = eng().value; out.mismatchVoice = voice().value;
      // Put back Emma for the playback check.
      await aria.config.set('tts.engine', 'kokoro'); await aria.config.set('tts.voice', 'bf_emma');
      document.getElementById('settings-close').click();
      return out;
    })()`);
    // The sidecar must actually load the chosen voice and speak.
    await sleep(2500);
    const spoke = await ev(`(async () => {
      let bytes = 0; aria.tts.onAudio((p) => { bytes += (p && p.pcm && p.pcm.byteLength) || 0; });
      const ep = await aria.tts.stop({ epoch: 0 });
      aria.tts.play({ text: 'Hello, I am Emma.', replyId: 'voice-check', requestId: 'voice-check:1', epoch: ep });
      aria.tts.replyDone({ replyId: 'voice-check', epoch: ep });
      for (let i = 0; i < 300 && bytes === 0; i++) await new Promise(r => setTimeout(r, 100));
      await new Promise(r => setTimeout(r, 500));
      return bytes;
    })()`);
    r.spokeBytes = spoke;
    r.sidecarVoice = (log.match(/\[tts\] initialized: [^\n]*/g) || []).pop() || '';
    ws.close();
    console.log(JSON.stringify(r, null, 2));
    const checks = {
      engineChoice: r.engines.join() === 'kokoro,piper,elevenlabs,cartesia,openai,deepgram',
      kokoroListsAllVoices: r.kokoroVoices.length === 28 && r.kokoroVoices.every((v) => /^(af|am|bf|bm)_/.test(v)),
      piperListsOnlyPiper: r.piperVoices.join() === 'en_GB-alan-medium,en_US-lessac-medium' && r.piperDefault === 'en_GB-alan-medium',
      hintFollowsEngine: /Kokoro/.test(r.kokoroHint),
      remembersVoicePerEngine: r.rememberedKokoro === 'bf_emma',
      savesPair: r.savedEngine === 'kokoro' && r.savedVoice === 'bf_emma',
      reopensWithPair: r.reopenEngine === 'kokoro' && r.reopenVoice === 'bf_emma',
      // A Kokoro voice under engine=piper is normalised (main migrates it to kokoro); either way the UI must show a consistent pair.
      mismatchHandled: (r.mismatchEngine === 'kokoro' && /^(af|am|bf|bm)_/.test(r.mismatchVoice)) || (r.mismatchEngine === 'piper' && /^en_/.test(r.mismatchVoice)),
      chosenVoiceSpeaks: r.spokeBytes > 10000 && /engine=kokoro voice=bf_emma/.test(r.sidecarVoice),
    };
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    ok = Object.values(checks).every(Boolean);
  } catch (e) {
    console.error('[tts-ui] error:', e.message);
    console.error(log.split('\n').slice(-20).join('\n'));
  } finally {
    if (child) { child.kill('SIGTERM'); await sleep(1200); try { child.kill('SIGKILL'); } catch (e) {} }
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(ok ? 'smoke:tts-settings PASS' : 'smoke:tts-settings FAIL');
  process.exit(ok ? 0 : 1);
})();
