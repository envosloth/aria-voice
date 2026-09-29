#!/usr/bin/env node
/* Regression coverage for main-process hardening (pure Node, no Electron boot):
 *  - coordinator deleteHarnessSession settles on aborted/trickling/oversized responses
 *  - coordinator persistence failures never block onDone / the stream
 *  - no vision-retry / fallback after harness activity (tool event or token)
 *  - tool events from the direct LLM are ignored
 *  - "cancel everything" with one item has correct grammar
 *  - JsonStore rejects prototype keys; validateConfigSet allowlists keys/types
 *  - harness-detect normalizes wildcard bind hosts / IPv6 literals
 *  - tunnel supervisor ignores stale-child events and kills the process group
 * Requires a compiled dist/ (npx tsc). HOME is pointed at a temp dir and a
 * minimal `electron` stub is injected BEFORE any dist module loads.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-hardening-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
// Point $HERMES_HOME at the fake home too: detectHarness reads it FIRST, so a
// real Hermes home in the ambient environment would shadow these fixtures.
process.env.HERMES_HOME = path.join(tmpHome, '.hermes');

// Electron stub: no app (JsonStore falls back to ~/.aria), safeStorage unavailable
// (getSecret -> null, so no API key is attached).
const electronStub = {
  safeStorage: { isEncryptionAvailable: () => false },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: electronStub };

const dist = path.join(__dirname, '..', 'dist', 'main');
const llmStream = require(path.join(dist, 'llm-stream.js'));
const { config, validateConfigSet } = require(path.join(dist, 'config.js'));
const { JsonStore } = require(path.join(dist, 'json-store.js'));
const coordinator = require(path.join(dist, 'coordinator.js'));
const { detectHarness } = require(path.join(dist, 'harness-detect.js'));
const { TunnelSupervisor } = require(path.join(dist, 'tunnel-supervisor.js'));

let pass = true;
function check(name, cond, detail = '') {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms) {
  return Promise.race([p, sleep(ms).then(() => 'TIMEOUT')]);
}
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ---------------------------------------------------------------- json-store
async function testJsonStore() {
  const store = new JsonStore('proto-test', { a: { b: 1 } });
  let threw = false;
  try { store.set('__proto__.polluted', 'yes'); } catch { threw = true; }
  check('jsonstore-set-rejects-__proto__', threw && ({}).polluted === undefined);
  threw = false;
  try { store.set('a.constructor.prototype.polluted2', 'yes'); } catch { threw = true; }
  check('jsonstore-set-rejects-constructor/prototype', threw && ({}).polluted2 === undefined);
  check('jsonstore-get-own-only', store.get('a.constructor') === undefined && store.get('toString') === undefined);
  check('jsonstore-get-rejects-__proto__', store.get('__proto__') === undefined);
  let delOk = true;
  try { store.delete('__proto__.x'); } catch { delOk = true; }
  check('jsonstore-delete-proto-noop', delOk && typeof Object.prototype.hasOwnProperty === 'function');
  store.set('a.b', 2);
  check('jsonstore-normal-set-get', store.get('a.b') === 2);
}

// ------------------------------------------------------------ config validate
function testValidateConfigSet() {
  check('validate-exported', typeof validateConfigSet === 'function');
  if (typeof validateConfigSet !== 'function') return;
  const ok = (k, v) => validateConfigSet(k, v).ok === true;
  // Every key the renderer sets today must be accepted with its real value shape.
  const legit = [
    ['audio.volume', 0.5], ['tts.speed', 1.2], ['routing.mode', 'harness'], ['harness.id', 'hermes'],
    ['harness.endpoint', 'http://127.0.0.1:8642/v1'], ['harness.model', 'hermes-agent'],
    ['remote.enabled', true], ['remote.target', 'custom'], ['remote.sshHost', 'me@box'],
    ['remote.sshPort', 22], ['remote.identityFile', '~/.ssh/id_ed25519'], ['remote.remoteHost', '127.0.0.1'],
    ['remote.remotePort', 8642], ['remote.localPort', 0], ['remote.autoReconnect', false],
    ['ui.perfPreset', 'balanced'], ['llm.endpoint', ''], ['llm.model', 'x'], ['ui.setup-needed', true],
    ['stt.model', 'small'], ['stt.backend', 'cpu'], ['tts.engine', 'piper'], ['tts.voice', 'bm_george'],
    ['wakeword.enabled', false], ['wakeword.phrase', 'hey_jarvis'], ['conversation.enabled', true],
    ['ui.theme', 'nord'], ['ui.onboarded', true], ['remote.rawCommand', ''],
  ];
  const bad = legit.filter(([k, v]) => !ok(k, v));
  check('validate-accepts-renderer-keys', bad.length === 0, bad.length ? JSON.stringify(bad) : '');
  check('validate-rejects-unknown-key', !ok('evil.key', 'x'));
  check('validate-rejects-object-subtree', !ok('remote', { rawCommand: 'sh -c x' }));
  check('validate-rejects-proto-key', !ok('__proto__.x', 1) && !ok('ui.constructor', 1));
  check('validate-rejects-type-mismatch', !ok('audio.volume', '1') && !ok('ui.onboarded', 'yes') && !ok('llm.endpoint', 3));
  check('validate-rejects-nonfinite', !ok('audio.volume', NaN) && !ok('remote.sshPort', Infinity));
  check('validate-rejects-bad-enum', !ok('routing.mode', 'shell') && !ok('stt.backend', 'rocm'));
  check('validate-rawcommand-strict-mode',
    validateConfigSet('remote.rawCommand', 'ssh -N x', { rejectRawCommand: true }).ok === false &&
    validateConfigSet('remote.rawCommand', '', { rejectRawCommand: true }).ok === true);
}

// ------------------------------------------------------------ harness-detect
function testHarnessDetect() {
  const envDir = path.join(tmpHome, '.hermes');
  fs.mkdirSync(envDir, { recursive: true });
  const cases = [
    ['0.0.0.0', 'http://127.0.0.1:8642/v1/chat/completions'],
    ['::', 'http://127.0.0.1:8642/v1/chat/completions'],
    ['[::]', 'http://127.0.0.1:8642/v1/chat/completions'],
    ['::1', 'http://[::1]:8642/v1/chat/completions'],
    ['127.0.0.1', 'http://127.0.0.1:8642/v1/chat/completions'],
  ];
  for (const [host, want] of cases) {
    fs.writeFileSync(path.join(envDir, '.env'), `API_SERVER_KEY=k\nAPI_SERVER_HOST=${host}\nAPI_SERVER_PORT=8642\n`);
    const got = detectHarness('hermes').endpoint;
    check(`harness-detect-host-${host}`, got === want, `got ${got}`);
  }
  fs.writeFileSync(path.join(envDir, '.env'), 'API_SERVER_KEY=k\nAPI_SERVER_HOST=\nAPI_SERVER_PORT=8642\n');
  check('harness-detect-empty-host', detectHarness('hermes').endpoint === 'http://127.0.0.1:8642/v1/chat/completions');
}

// ------------------------------------------------ coordinator delete-session
async function testDeleteHarnessSession() {
  check('delete-harness-exported', typeof coordinator.deleteHarnessSession === 'function');
  if (typeof coordinator.deleteHarnessSession !== 'function') return;
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const mode = decodeURIComponent(req.url.split('/').pop());
    if (mode === 'partial') {
      res.writeHead(500, { 'Content-Length': '1000' });
      res.write('partial body');
      setTimeout(() => req.socket.destroy(), 50);
    } else if (mode === 'trickle') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const iv = setInterval(() => { try { res.write('.'); } catch { clearInterval(iv); } }, 100);
      res.on('close', () => clearInterval(iv));
    } else if (mode === 'huge') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.write(Buffer.alloc(200 * 1024, 'x'));
      // never ends
    } else {
      res.writeHead(204); res.end();
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const port = await listen(server);
  config.set('harness.endpoint', `http://127.0.0.1:${port}/v1/chat/completions`);

  const okRes = await withTimeout(coordinator.deleteHarnessSession('fine'), 3000);
  check('delete-ok', okRes !== 'TIMEOUT' && okRes.deleted === true);

  let t = Date.now();
  const partial = await withTimeout(coordinator.deleteHarnessSession('partial'), 3000);
  check('delete-partial-then-destroy-settles', partial !== 'TIMEOUT' && partial.deleted === false,
    partial === 'TIMEOUT' ? 'hung' : `${Date.now() - t}ms ${JSON.stringify(partial)}`);

  t = Date.now();
  const trickle = await withTimeout(coordinator.deleteHarnessSession('trickle', { deadlineMs: 800 }), 3000);
  check('delete-trickle-hits-deadline', trickle !== 'TIMEOUT' && trickle.deleted === false,
    trickle === 'TIMEOUT' ? 'hung' : `${Date.now() - t}ms ${JSON.stringify(trickle)}`);

  const huge = await withTimeout(coordinator.deleteHarnessSession('huge'), 3000);
  check('delete-body-capped', huge !== 'TIMEOUT' && huge.deleted === false && !(huge.error || '').includes('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
    huge === 'TIMEOUT' ? 'hung' : (huge.error || '').slice(0, 80));
  for (const s of sockets) s.destroy();
  server.close();
}

// ------------------------------------------------- coordinator stream policy
// Replace streamChat with a scripted fake (coordinator calls it through the
// module exports object, so reassigning the export intercepts it).
function scriptStream(script) {
  const calls = [];
  llmStream.streamChat = (opts, cbs) => {
    const call = { opts, idx: calls.length };
    calls.push(call);
    const step = script[call.idx] || script[script.length - 1];
    setImmediate(() => step(cbs, call));
    return { cancel() {} };
  };
  return calls;
}
function runTurn(msg, opts = {}) {
  return new Promise((resolve) => {
    const out = { tokens: [], tools: [], errors: [], done: null, routes: [] };
    const finish = () => resolve(out);
    const timer = setTimeout(() => { out.timeout = true; finish(); }, 2500);
    coordinator.coordinate(msg, {
      onToken: (tk) => out.tokens.push(tk),
      onTool: (info) => out.tools.push(info.name),
      onDone: (txt) => { out.done = txt; clearTimeout(timer); finish(); },
      onError: (e) => { out.errors.push(e); clearTimeout(timer); finish(); },
      onRoute: (r) => out.routes.push(r.name),
    }, opts).catch((e) => { out.errors.push('THREW ' + e.message); clearTimeout(timer); finish(); });
  });
}

async function testStreamPolicy() {
  config.set('llm.endpoint', 'http://127.0.0.1:9/v1/chat/completions');
  config.set('harness.endpoint', 'http://127.0.0.1:9/v1/chat/completions');
  config.set('routing.mode', 'harness');

  // 3a: harness emitted a tool event, then the connection failed -> no fallback.
  coordinator.resetConversation();
  let calls = scriptStream([
    (cb) => { cb.onTool({ name: 'web_search' }); cb.onError('LLM connection failed: ECONNREFUSED. Check endpoint and network.'); },
    (cb) => { cb.onToken('fallback reply'); cb.onDone('fallback reply'); },
  ]);
  let r = await runTurn('look up the news');
  check('no-fallback-after-tool-activity', calls.length === 1 && r.errors.length === 1 && r.done === null,
    `calls=${calls.length} done=${JSON.stringify(r.done)} errors=${r.errors.length}`);

  // 3b: harness emitted a tool event, then rejected vision -> no text-only retry.
  coordinator.resetConversation();
  calls = scriptStream([
    (cb) => { cb.onTool({ name: 'screenshot' }); cb.onError('LLM returned 400: unknown variant image_url'); },
    (cb) => { cb.onToken('retry reply'); cb.onDone('retry reply'); },
  ]);
  r = await runTurn('what is on my screen', { image: 'data:image/png;base64,AAAA' });
  check('no-vision-retry-after-tool-activity', calls.length === 1 && r.errors.length === 1,
    `calls=${calls.length} errors=${r.errors.length}`);

  // 3c: control — no activity -> fallback still happens.
  coordinator.resetConversation();
  calls = scriptStream([
    (cb) => { cb.onError('LLM connection failed: ECONNREFUSED. Check endpoint and network.'); },
    (cb) => { cb.onToken('fallback reply'); cb.onDone('fallback reply'); },
  ]);
  r = await runTurn('look up the news');
  check('fallback-still-works-without-activity', calls.length === 2 && r.done === 'fallback reply',
    `calls=${calls.length} done=${JSON.stringify(r.done)}`);

  // 4: direct LLM tool events are ignored (not forwarded, not recorded).
  config.set('routing.mode', 'llm');
  coordinator.resetConversation();
  calls = scriptStream([
    (cb) => { cb.onTool({ name: 'delegate_to_agent' }); cb.onToken('hi'); cb.onDone('hi'); },
    (cb) => { cb.onDone('second'); },
  ]);
  r = await runTurn('explain rainbows');
  check('llm-tool-events-not-forwarded', r.tools.length === 0 && r.done === 'hi', `tools=${JSON.stringify(r.tools)}`);
  r = await runTurn('and why');
  const hist = calls[1] ? calls[1].opts.messages.filter((m) => m.role !== 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n') : '';
  check('llm-tool-events-not-recorded', !/agent tools used/.test(hist));

  // 2: persistence errors must not block onDone (stream start / local intent).
  const sessionsTmp = path.join(tmpHome, '.aria', 'sessions.json.tmp');
  fs.mkdirSync(sessionsTmp, { recursive: true }); // renameSync/writeFileSync -> EISDIR
  const origErr = console.error; const origWarn = console.warn;
  console.error = () => {}; console.warn = () => {};
  try {
    config.set('routing.mode', 'harness');
    coordinator.resetConversation();
    scriptStream([(cb) => { cb.onToken('ok'); cb.onDone('ok'); }]);
    r = await runTurn('look up the news');
    check('persist-failure-does-not-block-stream', r.done === 'ok' && !r.errors.some((e) => e.startsWith('THREW')),
      JSON.stringify({ done: r.done, errors: r.errors, timeout: !!r.timeout }));
    config.set('routing.mode', 'auto');
    r = await runTurn('what time is it');
    check('persist-failure-does-not-block-local-intent', typeof r.done === 'string' && r.done.length > 0,
      JSON.stringify({ done: r.done, errors: r.errors }));
  } finally {
    console.error = origErr; console.warn = origWarn;
    fs.rmSync(sessionsTmp, { recursive: true, force: true });
  }

  // 5: "cancel everything" with exactly one item.
  config.set('routing.mode', 'auto');
  coordinator.resetConversation();
  await runTurn('cancel everything');
  await runTurn('set a timer for 5 minutes');
  r = await runTurn('cancel everything');
  check('cancel-all-single-grammar', r.done === 'Cancelled your timer.', `got ${JSON.stringify(r.done)}`);
}

// ------------------------------------------------------------ tunnel supervisor
function writeScript(name, body) {
  const p = path.join(tmpHome, name);
  fs.writeFileSync(p, body);
  return p;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function testTunnel() {
  config.set('remote.sshHost', 'test@localhost');
  config.set('remote.enabled', true);
  config.set('remote.autoReconnect', false);
  config.set('remote.target', 'custom');

  // 8: stale child exit must not clobber the new child.
  const exiter = writeScript('exit-soon.js', 'process.stderr.write("old child noise\\n"); setTimeout(() => process.exit(1), 400);');
  const sleeper = writeScript('sleep-long.js', 'setTimeout(() => {}, 30000);');
  const sup = new TunnelSupervisor();
  config.set('remote.rawCommand', `${process.execPath} ${exiter}`);
  sup.start();
  const oldChild = sup.child;
  // Simulate the stop→start race where the old process's exit arrives late.
  // Detach the old process from stop()'s kill so it exits on its own later.
  sup.child = null;
  sup.stop();
  config.set('remote.rawCommand', `${process.execPath} ${sleeper}`);
  sup.start();
  const newChild = sup.child;
  await sleep(900);
  check('tunnel-stale-exit-ignored', !!newChild && newChild !== oldChild && sup.child === newChild && sup.state === 'starting',
    `state=${sup.state} childIsNew=${sup.child === newChild}`);
  check('tunnel-stale-stderr-ignored', !/old child noise/.test(sup.lastMessage || ''), `msg=${sup.lastMessage}`);
  sup.stop();

  // 9: stop() kills the whole process group (grandchild too).
  if (process.platform !== 'win32') {
    const pidFile = path.join(tmpHome, 'grandchild.pid');
    const parent = writeScript('spawn-grandchild.js',
      `const { spawn } = require('child_process');\n` +
      `const gc = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });\n` +
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));\n` +
      `setTimeout(() => {}, 30000);\n`);
    config.set('remote.rawCommand', `${process.execPath} ${parent}`);
    const sup2 = new TunnelSupervisor();
    sup2.start();
    for (let i = 0; i < 40 && !fs.existsSync(pidFile); i++) await sleep(50);
    const gcPid = Number(fs.readFileSync(pidFile, 'utf8'));
    sup2.stop();
    await sleep(700);
    const gcAlive = alive(gcPid);
    check('tunnel-stop-kills-process-group', !gcAlive, `grandchild ${gcPid} alive=${gcAlive}`);
    if (gcAlive) { try { process.kill(gcPid, 'SIGKILL'); } catch { /* ignore */ } }
  }
  config.set('remote.enabled', false);
  config.set('remote.rawCommand', '');
}

(async () => {
  try {
    await testJsonStore();
    testValidateConfigSet();
    testHarnessDetect();
    await testDeleteHarnessSession();
    await testStreamPolicy();
    await testTunnel();
  } catch (e) {
    pass = false;
    console.log(`[unexpected-exception] FAIL — ${e && e.stack}`);
  }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(pass ? 0 : 1);
})();
