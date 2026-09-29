#!/usr/bin/env node
/* Hermes/OpenClaw auto-detect: config discovery (.env, config.yaml, $HERMES_HOME,
 * process env) plus the live probe against a mock gateway that behaves like the
 * real API server (/health open, /v1/models bearer-protected). Plain Node,
 * needs `npm run build` first. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-detect-'));
process.env.HOME = tmpHome;            // os.homedir() honours HOME on POSIX
delete process.env.HERMES_HOME;
for (const k of ['API_SERVER_KEY', 'API_SERVER_HOST', 'API_SERVER_PORT', 'API_SERVER_MODEL_NAME', 'API_SERVER_ENABLED']) delete process.env[k];

const D = require('../dist/main/harness-detect');
let pass = true;
const check = (name, ok, detail = '') => {
  if (!ok) pass = false;
  console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
};

const hermesDir = path.join(tmpHome, '.hermes');
fs.mkdirSync(hermesDir, { recursive: true });
const writeEnv = (t) => fs.writeFileSync(path.join(hermesDir, '.env'), t);
const writeYaml = (t) => fs.writeFileSync(path.join(hermesDir, 'config.yaml'), t);
const clear = () => { for (const f of ['.env', 'config.yaml']) fs.rmSync(path.join(hermesDir, f), { force: true }); };

const KEY = 'a'.repeat(32);

function gateway({ key = KEY, healthOk = true } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(healthOk ? { status: 'ok', platform: 'hermes-agent' } : { hello: 'world' }));
    } else if (req.url === '/v1/models') {
      if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); res.end('{"error":"bad key"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'my-hermes', object: 'model' }] }));
    } else { res.writeHead(404); res.end(); }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
const origin = (s) => `http://127.0.0.1:${s.address().port}`;
const closed = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  // ---- static discovery ----
  clear();
  writeYaml(['gateway:', '  api_server:', '    enabled: true', '    port: 9911', '    host: 0.0.0.0', `    key: ${KEY}`, '    model_name: from-yaml', ''].join('\n'));
  let r = D.detectHarness('hermes');
  check('yaml-key-found', r.found && r.apiKey === KEY, r.message);
  check('yaml-port-host', r.endpoint === 'http://127.0.0.1:9911/v1/chat/completions', r.endpoint);
  check('yaml-model', r.model === 'from-yaml');

  writeEnv(`API_SERVER_KEY=${'b'.repeat(20)}\nAPI_SERVER_PORT=9922\n`);
  r = D.detectHarness('hermes');
  check('env-beats-yaml', r.apiKey === 'b'.repeat(20) && r.endpoint.includes(':9922/'), r.endpoint);

  for (const spelling of [
    ['gateway:', '  platforms:', '    api_server:', `      key: ${KEY}`, '      port: 9933'],
    ['platforms:', '  api_server:', '    extra:', `      key: ${KEY}`, '    port: 9934'],
  ]) {
    clear(); writeYaml(spelling.join('\n') + '\n');
    r = D.detectHarness('hermes');
    check('yaml-alt-spelling', r.found && r.apiKey === KEY, spelling[1]);
  }

  clear(); writeYaml(['gateway:', '  api_server:', '    key: "quoted-key-0123456789abcdef" # note', ''].join('\n'));
  r = D.detectHarness('hermes');
  check('yaml-quoted-and-comment', r.apiKey === 'quoted-key-0123456789abcdef', r.apiKey);

  clear(); writeEnv('API_SERVER_KEY=short\n');
  r = D.detectHarness('hermes');
  check('weak-key-flagged', r.found === false && r.status === 'weak-key' && /16/.test(r.message), r.message);

  clear();
  process.env.HERMES_HOME = path.join(tmpHome, 'relocated');
  fs.mkdirSync(process.env.HERMES_HOME);
  fs.writeFileSync(path.join(process.env.HERMES_HOME, '.env'), `API_SERVER_KEY=${KEY}\n`);
  r = D.detectHarness('hermes');
  check('hermes-home-honoured', r.found && r.apiKey === KEY, r.message);
  delete process.env.HERMES_HOME;

  clear();
  process.env.API_SERVER_KEY = KEY; process.env.API_SERVER_PORT = '9944';
  r = D.detectHarness('hermes');
  check('process-env-port-and-key', r.found && r.endpoint.includes(':9944/'), r.endpoint);
  delete process.env.API_SERVER_KEY; delete process.env.API_SERVER_PORT;

  // ---- live probe ----
  const gw = await gateway();
  clear(); writeEnv(`API_SERVER_KEY=${KEY}\nAPI_SERVER_PORT=${gw.address().port}\n`);
  r = await D.detectHarnessLive('hermes', { fallbackOrigins: [] });
  check('live-ready', r.status === 'ready' && r.verified === true && r.model === 'my-hermes', `${r.status} ${r.model}`);
  check('live-endpoint', r.endpoint === `${origin(gw)}/v1/chat/completions`, r.endpoint);

  // configured port is wrong, gateway sits on the stock port -> found via fallback
  const dead = await closed();
  writeEnv(`API_SERVER_KEY=${KEY}\nAPI_SERVER_PORT=${dead}\n`);
  r = await D.detectHarnessLive('hermes', { fallbackOrigins: [origin(gw)] });
  check('live-fallback-origin', r.status === 'ready' && r.endpoint.startsWith(origin(gw)), `${r.status} ${r.endpoint}`);

  // key on disk is stale -> gateway answers 401
  writeEnv(`API_SERVER_KEY=${'z'.repeat(24)}\nAPI_SERVER_PORT=${gw.address().port}\n`);
  r = await D.detectHarnessLive('hermes', { fallbackOrigins: [] });
  check('live-key-rejected', r.status === 'key-rejected' && r.verified === false && /restart/i.test(r.message), r.message);

  // running, but no key anywhere
  clear(); writeEnv(`API_SERVER_PORT=${gw.address().port}\n`);
  r = await D.detectHarnessLive('hermes', { fallbackOrigins: [] });
  check('live-running-no-key', r.status === 'running-no-key' && !r.found, r.message);

  // key present, nothing listening
  writeEnv(`API_SERVER_KEY=${KEY}\nAPI_SERVER_PORT=${dead}\n`);
  r = await D.detectHarnessLive('hermes', { fallbackOrigins: [] });
  check('live-not-running', r.status === 'not-running' && r.found === true && /gateway/i.test(r.message), r.message);

  // nothing configured, nothing listening -> tell the user how to enable it
  clear();
  r = await D.detectHarnessLive('hermes', { fallbackOrigins: [] });
  check('live-not-enabled', r.status === 'not-enabled' && /API_SERVER_KEY/.test(r.message), r.message);

  // a random app on the port is not Hermes
  const impostor = await gateway({ healthOk: false });
  writeEnv(`API_SERVER_KEY=${KEY}\nAPI_SERVER_PORT=${impostor.address().port}\n`);
  r = await D.detectHarnessLive('hermes', { fallbackOrigins: [] });
  check('live-impostor-not-hermes', r.status === 'not-running', r.status);

  // never probe or send a key to a non-loopback host
  writeEnv(`API_SERVER_KEY=${KEY}\nAPI_SERVER_HOST=203.0.113.9\nAPI_SERVER_PORT=8642\n`);
  const t0 = Date.now();
  r = await D.detectHarnessLive('hermes', { fallbackOrigins: [], timeoutMs: 800 });
  check('live-skips-remote-host', r.verified === false && Date.now() - t0 < 700, `${Date.now() - t0}ms ${r.status}`);

  // a server that never answers must not hang detection
  const hang = http.createServer(() => {});
  await new Promise((res) => hang.listen(0, '127.0.0.1', res));
  writeEnv(`API_SERVER_KEY=${KEY}\nAPI_SERVER_PORT=${hang.address().port}\n`);
  const t1 = Date.now();
  r = await D.detectHarnessLive('hermes', { fallbackOrigins: [], timeoutMs: 400 });
  check('live-bounded-on-hang', Date.now() - t1 < 3000 && r.verified === false, `${Date.now() - t1}ms ${r.status}`);

  check('unknown-harness', (await D.detectHarnessLive('nope')).found === false);

  for (const s of [gw, impostor, hang]) { s.closeAllConnections?.(); s.close(); }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
