#!/usr/bin/env node
// IPv6 transport tests against an actual loopback listener; no external requests.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os');
const path = require('node:path'), http = require('node:http'), crypto = require('node:crypto'), Module = require('node:module');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-ipv6-'));
process.env.HOME = home; process.env.USERPROFILE = home; process.env.ARIA_MODELS_DIR = path.join(home, 'models');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => home, getVersion: () => '0.0.0' }, safeStorage: { isEncryptionAvailable: () => false } };
  return load.call(this, name, ...args);
};
const { streamChat } = require('../dist/main/llm-stream');
const { listModels } = require('../dist/main/llm-models');
const { config } = require('../dist/main/config');
const { deleteHarnessSession } = require('../dist/main/coordinator');
const { downloadModel } = require('../dist/main/model-manager');
// Exercise the compiled private GET helper without adding a production test API.
const file = path.resolve(__dirname, '../dist/main/updater.js');
const updater = new Module(file, module); updater.filename = file; updater.paths = Module._nodeModulePaths(path.dirname(file));
updater._compile(fs.readFileSync(file, 'utf8') + '\nexports.auditHttpGet = httpGet;\n', file);
const bytes = Buffer.from('verified ipv6 model fixture');
let failures = 0;
async function check(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); } }
(async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); }
    else if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"fixture"}]}'); }
    else if (req.url === '/asset') { res.setHeader('Content-Length', bytes.length); res.end(bytes); }
    else { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '::1', resolve); });
    const base = `http://[::1]:${server.address().port}`;
    await check('IPv6 chat', async () => {
      const text = await new Promise((resolve, reject) => streamChat({ endpoint: base + '/v1', model: 'fixture' }, { onToken: () => {}, onDone: resolve, onError: e => reject(new Error(e)) }));
      assert.equal(text, 'hello');
    });
    await check('IPv6 discovery', async () => { const r = await listModels(base + '/v1', null); assert.equal(r.ok, true, r.error); assert.deepEqual(r.models, ['fixture']); });
    await check('IPv6 harness deletion', async () => { config.set('harness.endpoint', base + '/v1'); const r = await deleteHarnessSession('fixture'); assert.equal(r.deleted, true, r.error); });
    await check('IPv6 verified model download', async () => {
      await downloadModel({ id: 'fixture', kind: 'stt', file: 'fixture.bin', url: base + '/asset', sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), required: true });
      assert.deepEqual(fs.readFileSync(path.join(process.env.ARIA_MODELS_DIR, 'fixture.bin')), bytes);
    });
    await check('IPv6 update GET', async () => { const chunks = []; const r = await updater.exports.auditHttpGet(base + '/asset', c => chunks.push(c)); assert.equal(r.statusCode, 200); assert.deepEqual(Buffer.concat(chunks), bytes); });
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(home, { recursive: true, force: true }); }
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
