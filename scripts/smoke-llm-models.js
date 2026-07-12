#!/usr/bin/env node
/* Unit test for model auto-discovery (src/main/llm-models.ts).
 * Covers the two pure parsers — normalizeChatBaseUrl (URL-shape -> /v1/models)
 * and pickRecommended (default heuristic) — plus one live round-trip through
 * listModels against a mock OpenAI-compatible server: the OpenAI {data:[{id}]}
 * shape, a bare {models:[...]} shape, non-2xx surfacing, and non-JSON bodies.
 */

const http = require('http');
const { normalizeChatBaseUrl, pickRecommended, listModels } = require('../dist/main/llm-models');

let pass = true;
function check(name, cond, detail) {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL' + (detail ? ' -> ' + detail : '')}`);
}
const path = (u) => { const r = normalizeChatBaseUrl(u); return r ? r.pathname : null; };

// --- normalizeChatBaseUrl: every input shape resolves to the /v1/models route
check('norm.host-only', path('http://127.0.0.1:8642') === '/v1/models');
check('norm.v1-base', path('http://127.0.0.1:11434/v1') === '/v1/models');
check('norm.full-chat', path('https://api.deepseek.com/v1/chat/completions') === '/v1/models');
check('norm.trailing-slash', path('http://h:1234/v1/') === '/v1/models');
check('norm.already-models', path('http://h:1234/v1/models') === '/v1/models', path('http://h:1234/v1/models')); // no double-append
check('norm.garbage', path('not a url') === null);

// --- pickRecommended: default > latest > auto, else alphabetical, else undefined
check('pick.default-wins', pickRecommended(['a-model', 'x-latest', 'the-default']) === 'the-default');
check('pick.latest-over-auto', pickRecommended(['auto-x', 'foo-latest']) === 'foo-latest');
check('pick.alphabetical', pickRecommended(['zeta', 'alpha', 'mid']) === 'alpha');
check('pick.empty', pickRecommended([]) === undefined);
check('pick.non-strings', pickRecommended([1, null, 'only-one', '']) === 'only-one');

// --- listModels round-trip against a mock server
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') { // OpenAI data[] shape + a duplicate id to dedup
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }, { bad: 'no-id' }] }));
  } else if (req.url === '/alt/models') { // proxy that nests under "models"
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: ['solo-model'] }));
  } else if (req.url === '/bad/models') {
    res.writeHead(500); res.end('boom');
  } else if (req.url === '/notjson/models') {
    res.writeHead(200); res.end('<html>nope</html>');
  } else { res.writeHead(404); res.end(); }
});

server.listen(0, async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const ok = await listModels(base, '');
    check('list.ok', ok.ok === true, JSON.stringify(ok));
    check('list.deduped', JSON.stringify(ok.models) === JSON.stringify(['b-model', 'a-model']), JSON.stringify(ok.models));
    check('list.recommended', ok.recommended === 'a-model', ok.recommended); // alphabetical

    const alt = await listModels(`${base}/alt`, '');
    check('list.models-shape', alt.ok && alt.models.length === 1 && alt.models[0] === 'solo-model', JSON.stringify(alt));

    const bad = await listModels(`${base}/bad`, '');
    check('list.5xx-surfaced', bad.ok === false && /500/.test(bad.error || ''), JSON.stringify(bad));

    const nj = await listModels(`${base}/notjson`, '');
    check('list.non-json', nj.ok === false && /JSON/.test(nj.error || ''), JSON.stringify(nj));

    const dead = await listModels('http://127.0.0.1:1/x', '');
    check('list.conn-fail', dead.ok === false, JSON.stringify(dead));

    const insecure = await listModels('http://example.invalid/v1', 'secret');
    check('list.remote-http-key-refused', insecure.ok === false && /HTTPS/.test(insecure.error || ''), JSON.stringify(insecure));
  } catch (e) {
    check('list.threw', false, String(e));
  } finally {
    server.close();
    console.log(pass ? '\nALL PASS' : '\nFAILED');
    process.exit(pass ? 0 : 1);
  }
});
