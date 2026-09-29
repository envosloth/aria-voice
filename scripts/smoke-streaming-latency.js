#!/usr/bin/env node
// Real Electron renderer, local SSE fixture and real Piper audio. No real profile.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const root = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-stream-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reply = 'A healthy daily routine provides lasting benefits such as better sleep improved concentration greater energy stronger relationships increased confidence reduced stress balanced nutrition regular exercise restful evenings consistent progress renewed motivation and sustainable personal growth.';
const samples = [];
const server = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const words = reply.split(' '); let i = 0;
    const timer = setInterval(() => {
      if (i < words.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] + ' ' } }] })}\n\n`);
      else { clearInterval(timer); res.end('data: [DONE]\n\n'); }
    }, 70);
    res.on('close', () => clearInterval(timer));
  });
});
(async () => {
  let child, ws, log = '';
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    child = spawn(require('electron'), ['--no-sandbox', '--mute-audio', '--remote-debugging-port=0', path.join(root, 'dist/main/index.js')], {
      cwd: root, env: { ...process.env, ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: home,
        HERMES_HOME: path.join(home, 'h'), XDG_CONFIG_HOME: path.join(home, 'x'), XDG_CACHE_HOME: path.join(home, 'c') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
    let port;
    for (let i = 0; i < 100 && !port; i++) { port = (log.match(/DevTools listening on ws:\/\/127.0.0.1:(\d+)/) || [])[1]; if (!port) await sleep(100); }
    assert.ok(port, 'debugger must be available');
    let page;
    for (let i = 0; i < 100 && !page; i++) {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p => p.type === 'page' && /index.html/.test(p.url));
      if (!page) await sleep(100);
    }
    assert.ok(page, 'renderer must load');
    ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const d = JSON.parse(e.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const ev = expression => new Promise((r,j) => { const n = ++id; const timer=setTimeout(()=>{pending.delete(n);j(new Error('renderer evaluation timed out'));},120000); pending.set(n,d=>{clearTimeout(timer);r(d);}); ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); })
      .then(d => { if (d.error || d.result.exceptionDetails) throw new Error(JSON.stringify(d).slice(0, 500)); return d.result.result.value; });
    await sleep(1500);
    await ev(`(async()=>{await aria.config.set('llm.endpoint',${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1/chat/completions`)});await aria.config.set('llm.model','mock');await aria.config.set('routing.mode','llm');await aria.config.set('audio.volume',0);await aria.config.set('tts.engine','piper');await aria.config.set('tts.voice','en_GB-alan-medium');document.querySelectorAll('.onboard-overlay').forEach(e=>e.remove());document.getElementById('app-shell').inert=false;})()`);
    await ev(`(async()=>{const epoch=await aria.tts.epoch();let done=false;aria.tts.onState(s=>{if(s.replyId==='warm'&&s.state==='reply_done')done=true;});aria.tts.play({text:'Ready.',replyId:'warm',requestId:'warm:1',epoch});aria.tts.replyDone({replyId:'warm',epoch});for(let i=0;i<300&&!done;i++)await new Promise(r=>setTimeout(r,100));if(!done)throw new Error('Piper warmup failed');})()`);
    assert.ok(log.includes('engine=piper') && log.includes('[tts] ready'), 'real Piper sidecar must be warm and ready');
    console.log('ENGINE piper (ready)');
    for (let i = 0; i < 5; i++) {
      const result = await ev(`(async()=>{
        const wait=ms=>new Promise(r=>setTimeout(r,ms));
        await aria.tts.stop(); await wait(500);
        const out={};const start=performance.now();
        const untok=aria.llm.onToken(info=>{if(out.tokenMs===undefined){out.tokenMs=performance.now()-start;out.replyId=info.turnId+':'+info.generationId;}});
        const unaudio=aria.tts.onAudio(packet=>{if(packet.replyId===out.replyId&&out.audioMs===undefined)out.audioMs=performance.now()-start;});
        const unstate=aria.tts.onState(s=>{if(s.replyId===out.replyId&&s.state==='reply_done')out.replyDoneMs=performance.now()-start;});
        const und=aria.llm.onDone(()=>{out.doneMs=performance.now()-start;});
        const input=document.getElementById('text-input');input.value='Explain a healthy daily routine.';input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('send-btn').click();
        const end=performance.now()+20000;
        while((out.audioMs===undefined||out.doneMs===undefined||out.replyDoneMs===undefined)&&performance.now()<end)await wait(20);
        if(typeof untok==='function')untok();if(typeof unaudio==='function')unaudio();if(typeof und==='function')und();if(typeof unstate==='function')unstate();
        out.transcript=[...document.querySelectorAll('.message.assistant')].at(-1)?.textContent.trim();
        return out;
      })()`);
      assert.ok(Number.isFinite(result.audioMs), 'actual PCM must arrive');
      assert.ok(Number.isFinite(result.doneMs) && Number.isFinite(result.replyDoneMs), 'LLM and every queued TTS request must finish');
      assert.strictEqual(result.transcript, reply, 'full response must survive early speech');
      samples.push(result); console.log(JSON.stringify(result));
    }
    const median = xs => xs.slice().sort((a,b)=>a-b)[Math.floor(xs.length/2)];
    const firstAudio = median(samples.map(s=>s.audioMs));
    console.log(JSON.stringify({ medianFirstAudioMs: firstAudio, samples }));
    // Optional full local pipeline probe through the shipped Performance IPC.
    // Real Piper-generated speech -> real CPU Whisper -> local SSE -> real Piper.
    // This excludes microphone/VAD hang and provider-network variance.
    if (process.argv.includes('--voice')) {
      await ev(`(async()=>{await aria.config.set('stt.model','base.en');await aria.config.set('stt.backend','cpu');await aria.config.set('stt.provider','local');})()`);
      await sleep(2000);
      const warm = await ev('aria.perf.latencyTest()');
      assert.ok(warm.ok, JSON.stringify(warm));
      const voiceSamples = [];
      for (let i = 0; i < 3; i++) {
        const result = await ev('aria.perf.latencyTest()');
        assert.ok(result.ok, JSON.stringify(result));
        assert.strictEqual(result.reply, reply);
        assert.ok(result.transcript && Number.isFinite(result.firstAudioMs));
        voiceSamples.push(result); console.log(JSON.stringify({ voiceTrial: i + 1, ...result }));
      }
      console.log(JSON.stringify({ medianVoiceFirstAudioMs: median(voiceSamples.map(s=>s.firstAudioMs)), voiceSamples }));
    }
    assert.ok(firstAudio < 1000, `first audio must not wait for the 90-character cap: ${firstAudio.toFixed(0)}ms`);
    console.log('PASS streamed first audio before long opening sentence completes');
  } finally {
    fs.writeFileSync(path.join(os.tmpdir(), 'aria-stream-child.log'), log);
    if (ws) ws.close();
    if (child) { child.kill('SIGTERM'); await sleep(1500); if (child.exitCode === null) child.kill('SIGKILL'); }
    server.close(); fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(e => { console.error(e.message); process.exitCode=1; });
