#!/usr/bin/env node
// Real Electron liquid button/material and mic design regression.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-liquid-'));
const electron = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(port) {
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
    path.join(root, 'dist', 'main', 'index.js')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_SHOW: '1', ARIA_SMOKE_USER_DATA: userData,
      HERMES_HOME: path.join(userData, 'nh'),
      XDG_CONFIG_HOME: path.join(userData, 'x'), XDG_CACHE_HOME: path.join(userData, 'c') },
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}
async function connect(port) {
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
  const send = (method, params = {}) => new Promise((r,j) => { const n = ++id; const timer=setTimeout(()=>{pend.delete(n);j(new Error('CDP timeout '+method));},10000); pend.set(n,d=>{clearTimeout(timer);r(d)}); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 500)); return d.result.result.value; });
  return { ws, ev, send };
}

(async () => {
  let child, ws; const checks = [];
  const check = (name, result) => { checks.push({name, pass:!!result}); console.log(`${result?'PASS':'FAIL'} ${name}`); };
  try {
    const port = 9940 + Math.floor(Math.random()*50);
    child = boot(port);
    const c = await connect(port); ws = c.ws; const {ev,send} = c;
    await send('Emulation.setFocusEmulationEnabled', {enabled:true});
    await sleep(1200);
    await ev(`document.querySelectorAll('.onboard-overlay').forEach(e=>e.classList.remove('visible'));document.getElementById('app-shell').inert=false; const freeze=document.createElement('style');freeze.textContent='*,*::before,*::after{transition:none!important}';document.head.appendChild(freeze)`);
    for(const width of [1280,820]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
      await sleep(300);
      const m=await ev(`(()=>{const b=document.getElementById('mic-btn'),r=b.getBoundingClientRect(),s=getComputedStyle(b);return {width:r.width,height:r.height,radius:parseFloat(s.borderRadius),text:b.textContent.trim(),bars:b.querySelectorAll('.voice-wave i').length,glass:s.getPropertyValue('--liquid-glass').trim(),pressed:b.getAttribute('aria-pressed'),overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      check(`Talk pill at ${width}px`,m.width>=88&&m.height>=40&&m.radius>=20&&m.text==='Talk'&&m.bars===5&&m.glass==='1');
      check(`no overflow at ${width}px`,!m.overflow);
      await ev(`document.getElementById('settings-btn').click()`); await sleep(300);
      for(const tab of ['connections','voice','context','memory','appearance','performance','remote','updates']) {
        await ev(`document.getElementById('settings-tab-${tab}').click()`);await sleep(100);
        const fail=await ev(`[...document.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width&&getComputedStyle(b).visibility!=='hidden').filter(b=>{const s=getComputedStyle(b);return s.getPropertyValue('--liquid-glass').trim()!=='1'||s.boxShadow==='none'||(!b.classList.contains('bg-swatch')&&!s.backgroundImage.includes('gradient'))}).map(b=>b.id||b.className)`);
        check(`all visible ${tab} buttons use glass at ${width}px`,fail.length===0); if(fail.length)console.log(fail);
      }
      await ev(`document.getElementById('settings-close').click()`);await sleep(250);
      const shot=await send('Page.captureScreenshot',{format:'png'});
      const file=path.join(os.tmpdir(),`aria-liquid-${width}-${Date.now()}.png`);fs.writeFileSync(file,Buffer.from(shot.result.data,'base64'));console.log('SCREENSHOT '+file);
    }
    const mic=await ev(`(()=>{const b=document.getElementById('mic-btn');b.classList.add('listening');b.setAttribute('aria-pressed','true');const s=getComputedStyle(b.querySelector('.voice-wave i'));return {animation:s.animationName,label:b.getAttribute('aria-label')}})()`);
    check('listening waveform and accessible hold label',mic.animation==='liquid-voice-wave'&&/speak|talk/i.test(mic.label));
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    check('reduced motion disables listening animation',await ev(`getComputedStyle(document.querySelector('#mic-btn .voice-wave i')).animationName==='none'&&getComputedStyle(document.getElementById('mic-btn')).animationName==='none'`));
    await ev(`document.documentElement.dataset.blurOff='';`);
    check('blur off disables button filters',await ev(`[...document.querySelectorAll('button')].every(b=>getComputedStyle(b).backdropFilter==='none')`));
    await ev(`delete document.documentElement.dataset.blurOff;document.getElementById('mic-btn').classList.remove('listening');document.getElementById('mic-btn').setAttribute('aria-pressed','false');document.getElementById('settings-btn').focus()`);
    check('keyboard focus remains visible',await ev(`document.activeElement.id==='settings-btn'&&getComputedStyle(document.activeElement).outlineStyle!=='none'`));
    const dynamic=await ev(`(()=>{const b=document.createElement('button');b.textContent='Dynamic';document.body.appendChild(b);const s=getComputedStyle(b);const valid=s.getPropertyValue('--liquid-glass').trim()==='1'&&s.backgroundImage.includes('gradient');b.remove();return valid})()`);
    check('dynamically created buttons use glass',dynamic);
  }catch(e){console.error(e);check('test completed',false)}
  finally{if(ws)ws.close();if(child){child.kill('SIGTERM');await sleep(700);try{child.kill('SIGKILL')}catch{}}fs.rmSync(userData,{recursive:true,force:true})}
  console.log(JSON.stringify({passed:checks.filter(x=>x.pass).length,total:checks.length}));process.exit(checks.every(x=>x.pass)?0:1);
})();
