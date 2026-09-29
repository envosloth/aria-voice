#!/usr/bin/env node
// Behavioural regression: shipped brand image, provider save/reopen/reload,
// secret handling, and local accuracy controls in an isolated Electron profile.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const root = path.join(__dirname, '..');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-stt-settings-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let child, ws; let passed = 0;
  try {
    const port = 9400 + Math.floor(Math.random() * 200);
    child = spawn(require('electron'), ['--no-sandbox', `--remote-debugging-port=${port}`, path.join(root, 'dist/main/index.js')], {
      cwd: root, env: { ...process.env, ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_SHOW: '1', ARIA_SMOKE_USER_DATA: ud, HERMES_HOME: path.join(ud, 'no-hermes') }, stdio: 'ignore',
    });
    let target;
    for (let i = 0; i < 80 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && /index.html/.test(t.url)); } catch {}
      if (!target) await sleep(200);
    }
    assert(target, 'renderer must start');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pending = new Map();
    ws.onmessage = m => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const send = (method, params = {}) => Promise.race([new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }), sleep(15000).then(() => { throw Error('CDP timeout'); })]);
    const ev = async expression => { const d = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (d.result.exceptionDetails) throw Error(JSON.stringify(d.result.exceptionDetails)); return d.result.result.value; };
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await sleep(1600);
    await ev(`document.head.insertAdjacentHTML('beforeend','<style>*{transition:none!important}.onboard-overlay{display:none!important}</style>'); document.getElementById('app-shell').inert=false`);
    const settleSave = async () => {
      const done = await ev(`(async()=>{for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,100));if(!document.getElementById('settings-save').disabled && /Saved|Save failed/.test(document.getElementById('settings-saved-msg').textContent))return true;}return false;})()`);
      assert(done, 'Settings save must complete, not merely start');
    };
    const check = (label, condition) => { assert(condition, label); passed++; console.log('PASS ' + label); };
    const img = await ev(`(async()=>{const img=document.querySelector('.brand-mark'); if(img?.tagName === 'IMG' && !img.complete) await new Promise(r=>{img.onload=r;img.onerror=r});return {tag:img?.tagName,loaded:img?.naturalWidth>0,src:img?.getAttribute('src'),bg:img&&getComputedStyle(img).backgroundImage}})()`);
    check('brand is the actual shortcut image, not CSS gradient', img.tag === 'IMG' && img.loaded && img.src === 'assets/icon.png' && img.bg === 'none');
    check('distributed icon exactly matches canonical asset', fs.readFileSync(path.join(root, 'assets/icon.png')).equals(fs.readFileSync(path.join(root, 'dist/renderer/assets/icon.png'))));
    const installed = path.join(os.homedir(), '.local/share/icons/hicolor/512x512/apps/aria-voice.png');
    if (fs.existsSync(installed)) check('canonical image matches installed shortcut', fs.readFileSync(installed).equals(fs.readFileSync(path.join(root, 'assets/icon.png'))));
    const headerShot = await send('Page.captureScreenshot', {format:'png'});
    const headerPath = path.join(os.tmpdir(), `aria-header-retry-${Date.now()}.png`); fs.writeFileSync(headerPath, Buffer.from(headerShot.result.data,'base64'));console.log('SCREENSHOT '+headerPath);
    const open = () => ev(`(async()=>{document.getElementById('settings-btn').click();await new Promise(r=>setTimeout(r,300));document.getElementById('settings-tab-voice').click();await new Promise(r=>setTimeout(r,200));return {provider:document.getElementById('cfg-stt-provider').value,keyVisible:!document.getElementById('stt-cloud-key-row').hidden}})()`);
    let state = await open();
    check('fresh profile defaults to local with cloud key hidden', state.provider === 'local' && !state.keyVisible);
    await ev(`document.getElementById('cfg-stt-provider').value='groq';document.getElementById('cfg-stt-provider').dispatchEvent(new Event('change'));document.getElementById('settings-save').click()`);
    await settleSave();
    check('missing cloud key cannot silently enable cloud', await ev(`(async()=> (await aria.config.get('stt.provider'))==='local' && /key/i.test(document.getElementById('settings-saved-msg').textContent))()`));
    const secure = await ev('aria.secure.getBackend()');
    assert(secure.safe, 'OS keyring required to exercise credential persistence');
    // Synthetic test credential, never an account credential.
    await ev(`document.getElementById('cfg-stt-key').value='fixture-not-a-real-key';document.getElementById('cfg-stt-full-context').checked=true;document.getElementById('cfg-stt-prompt').value='Aria, Longmont, Blender.';document.getElementById('cfg-stt-groq-model').value='whisper-large-v3';document.getElementById('settings-save').click()`);
    await settleSave();
    check('real save persists provider, model, accuracy and vocabulary', await ev(`(async()=> (await aria.config.get('stt.provider'))==='groq' && (await aria.config.get('stt.groqModel'))==='whisper-large-v3' && (await aria.config.get('stt.fullContext'))===true && (await aria.config.get('stt.prompt'))==='Aria, Longmont, Blender.' && /Saved/.test(document.getElementById('settings-saved-msg').textContent))()`));
    const disk = fs.readFileSync(path.join(ud, 'aria-config.json'), 'utf8') + fs.readFileSync(path.join(ud, 'aria-secure.json'), 'utf8');
    check('test key absent from plaintext on disk', !disk.includes('fixture-not-a-real-key'));
    await ev(`document.getElementById('settings-close').click()`); state = await open();
    check('cloud selection reopens correctly', state.provider === 'groq' && state.keyVisible);
    await send('Emulation.setDeviceMetricsOverride', {width:820,height:900,deviceScaleFactor:1,mobile:false}); await sleep(300);
    check('cloud fields fit narrow settings', await ev(`document.querySelector('.settings-panel').scrollWidth <= document.querySelector('.settings-panel').clientWidth + 1`));
    const cloudShot=await send('Page.captureScreenshot',{format:'png'});const cloudPath=path.join(os.tmpdir(),`aria-cloud-retry-${Date.now()}.png`);fs.writeFileSync(cloudPath,Buffer.from(cloudShot.result.data,'base64'));console.log('SCREENSHOT '+cloudPath);
    check('saved key is not revealed in input', await ev(`document.getElementById('cfg-stt-key').value === ''`));
    await ev(`document.getElementById('settings-save').click()`); await settleSave();
    check('blank key preserves saved credential', await ev(`(async()=>Boolean(await aria.secure.get('stt-api-key')))()`));
    await send('Page.reload'); await sleep(2500); await ev(`document.head.insertAdjacentHTML('beforeend','<style>*{transition:none!important}.onboard-overlay{display:none!important}</style>');document.getElementById('app-shell').inert=false`); state = await open();
    check('provider survives page reload', state.provider === 'groq');
    await ev(`document.getElementById('cfg-stt-provider').value='local';document.getElementById('cfg-stt-provider').dispatchEvent(new Event('change'));document.getElementById('settings-save').click()`); await settleSave();
    check('switch back to private local processing', await ev(`(async()=> (await aria.config.get('stt.provider'))==='local' && document.getElementById('stt-cloud-key-row').hidden)()`));
    for (const width of [1280, 820]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(300);
      check('voice settings fit width ' + width, await ev(`document.querySelector('.settings-panel').scrollWidth <= document.querySelector('.settings-panel').clientWidth + 1`));
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const dest = path.join(os.tmpdir(), `aria-stt-retry-${width}-${Date.now()}.png`); fs.writeFileSync(dest, Buffer.from(shot.result.data, 'base64')); console.log('SCREENSHOT '+dest);
    }

    check('rounded logo corners', await ev(`parseFloat(getComputedStyle(document.querySelector('.brand-mark')).borderRadius)>=7`));
    await ev(`aria.config.set('context.clipboard',true)`);
    check('no header permission banner, even with context enabled', await ev(`!document.getElementById('context-indicator') && !document.querySelector('.chat-head').textContent.includes('ARIA can read')`));
    for (const provider of ['deepgram','assemblyai']) {
      await ev(`document.getElementById('cfg-stt-provider').value='${provider}';document.getElementById('cfg-stt-provider').dispatchEvent(new Event('change'));document.getElementById('settings-save').click()`); await settleSave();
      check(provider+' does not reuse Groq credentials', await ev(`(async()=> (await aria.config.get('stt.provider'))==='local' && /key/i.test(document.getElementById('settings-saved-msg').textContent))()`));
      await ev(`document.getElementById('cfg-stt-key').value='fixture-${provider}-only';document.getElementById('settings-save').click()`); await settleSave();
      check(provider+' saves its own credential', await ev(`(async()=> (await aria.config.get('stt.provider'))==='${provider}' && (await aria.secure.get('stt-${provider}-api-key'))==='fixture-${provider}-only' && (await aria.secure.get('stt-api-key'))==='fixture-not-a-real-key')()`));
      await ev(`document.getElementById('settings-close').click()`); state=await open();
      check(provider+' reopens with secret masked', state.provider===provider && await ev(`document.getElementById('cfg-stt-key').value===''`));
      await ev(`document.getElementById('cfg-stt-provider').value='local';document.getElementById('cfg-stt-provider').dispatchEvent(new Event('change'));document.getElementById('settings-save').click()`); await settleSave();
    }
    for (const engine of ['elevenlabs','cartesia','openai','deepgram']) {
      const localVoice=await ev(`aria.config.get('tts.voice')`);
      await ev(`document.getElementById('cfg-tts-engine').value='${engine}';document.getElementById('cfg-tts-engine').dispatchEvent(new Event('change'));document.getElementById('settings-save').click()`); await settleSave();
      const missingKeyState = await ev(`(async()=>({engine:await aria.config.get('tts.engine'), selected:document.getElementById('cfg-tts-engine').value,message:document.getElementById('settings-saved-msg').textContent}))()`);
      check(engine+' rejects missing TTS key', !['elevenlabs','cartesia','openai','deepgram'].includes(missingKeyState.engine) && /key/i.test(missingKeyState.message) || (()=>{console.log('DIAGNOSTIC',JSON.stringify(missingKeyState));return false;})());
      await ev(`document.getElementById('cfg-tts-key').value='fixture-${engine}-tts';document.getElementById('settings-save').click()`); await settleSave();
      const persistedTts=await ev(`(async()=>({engine:await aria.config.get('tts.engine'),voice:await aria.config.get('tts.voice'),keyMatches:(await aria.secure.get('tts-${engine}-api-key'))==='fixture-${engine}-tts',message:document.getElementById('settings-saved-msg').textContent}))()`);
      check(engine+' saves engine without overwriting local voice', persistedTts.engine===engine && persistedTts.voice===localVoice && persistedTts.keyMatches || (()=>{console.log('DIAGNOSTIC',JSON.stringify(persistedTts));return false;})());
      await ev(`document.getElementById('settings-close').click()`); await open();
      check(engine+' reopens with model and masked key', await ev(`document.getElementById('cfg-tts-engine').value==='${engine}' && document.getElementById('cfg-tts-key').value==='' && document.getElementById('cfg-tts-cloud-model').value.length>0`));
      await ev(`document.getElementById('settings-save').click()`); await settleSave();
      check(engine+' hides local voice picker visually', await ev(`getComputedStyle(document.getElementById('tts-local-voice-row')).display==='none'`));
      check(engine+' keeps key on blank save', await ev(`(async()=> (await aria.secure.get('tts-${engine}-api-key'))==='fixture-${engine}-tts')()`));
      if(engine==='cartesia') {
        await ev(`document.getElementById('cfg-tts-engine').closest('label').scrollIntoView({block:'start'})`); await sleep(250);
        const snap=await send('Page.captureScreenshot',{format:'png'});
        const dest=path.join(os.tmpdir(), 'aria-cloud-tts-'+Date.now()+'.png');fs.writeFileSync(dest,Buffer.from(snap.result.data,'base64'));console.log('SCREENSHOT '+dest);
      }
      await ev(`document.getElementById('cfg-tts-engine').value='kokoro';document.getElementById('cfg-tts-engine').dispatchEvent(new Event('change'));document.getElementById('settings-save').click()`); await settleSave();
    }
    await send('Page.reload'); await sleep(2500); await ev(`document.getElementById('app-shell').inert=false;document.getElementById('onboard-overlay').classList.remove('visible')`);await open();
    check('all provider keys survive reload independently',await ev(`(async()=> (await aria.secure.get('stt-deepgram-api-key'))==='fixture-deepgram-only' && (await aria.secure.get('tts-deepgram-api-key'))==='fixture-deepgram-tts')()`));
    check('all test secrets absent from plaintext disk', !fs.readFileSync(path.join(ud,'aria-config.json'),'utf8').includes('fixture-') && !fs.readFileSync(path.join(ud,'aria-secure.json'),'utf8').includes('fixture-'));
    console.log(`PASS ${passed} live checks`);
  } finally {
    if (ws) ws.close(); if (child) { child.kill('SIGTERM'); await sleep(600); if (child.exitCode === null) child.kill('SIGKILL'); }
    fs.rmSync(ud, { recursive: true, force: true });
  }
})().catch(e => { console.error('FAIL', e.message); process.exitCode=1; });
