#!/usr/bin/env node
/* Regenerate SCENE_GRIDS in src/renderer/appearance.js.
 *
 * The built-in backgrounds are CSS paintings, which the renderer cannot read
 * pixels from, so the adaptive text-contrast logic uses a coarse colour grid
 * measured from the real render. Rerun this after editing any scene's CSS:
 *
 *   npx electron --no-sandbox --user-data-dir=$(mktemp -d) --remote-debugging-port=9333 dist/main/index.js &
 *   node scripts/gen-scene-grids.mjs 9333
 *
 * Prints a JS object literal to paste over SCENE_GRIDS. Dev-only; not shipped. */
const port = process.argv[2] || '9333';
const W = 20, H = 12, VW = 1320, VH = 800;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const t = targets.find((x) => x.type === 'page' && /index\.html/.test(x.url));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
await ev(`(() => { const s = document.createElement('style'); s.id = '__gen'; s.textContent = '.shell,.onboard-overlay,.settings-overlay,.setup-toast{display:none!important}'; document.head.appendChild(s); return 1; })()`);
const out = {};
for (const bg of ['obsidian', 'studio', 'eclipse', 'aurora', 'dusk', 'ocean', 'observatory']) {
  await ev(`window.AriaAppearance.apply({ background: '${bg}', bgDim: 0 }), 1`);
  await sleep(600);
  const shot = (await send('Page.captureScreenshot', { format: 'png' })).result.data;
  out[bg] = await ev(`(async () => {
    const img = new Image(); img.src = 'data:image/png;base64,${shot}'; await img.decode();
    const c = new OffscreenCanvas(${W}, ${H}); const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${W}, ${H});
    const d = g.getImageData(0, 0, ${W}, ${H}).data; let s = '';
    for (let i = 0; i < d.length; i += 4) s += [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    return s;
  })()`);
}
await ev(`document.getElementById('__gen').remove(), 1`);
console.log(`const SCENE_GRIDS = { w: ${W}, h: ${H}, cells: {`);
for (const [k, v] of Object.entries(out)) console.log(`    ${k}: '${v}',`);
console.log('  } };');
ws.close();
