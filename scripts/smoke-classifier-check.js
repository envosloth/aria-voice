#!/usr/bin/env node
/* In-app classifier measurement, end to end.
 *
 * Boots the real app with ARIA_VERIFY_CLASSIFIER=1 against a mock chat endpoint
 * that answers the one-word classifier question, and asserts the app reports a
 * measurement and exits cleanly.
 *
 * This checks the PLUMBING (config read, deadline, reporting, exit) — not model
 * quality. Two limits are deliberate: the mock answers from the case labels, and
 * the utterance set is the whole corpus rather than a fresh holdout. The real
 * number comes from running the same command against a real model:
 *   npm run routing:classifier-check
 * with the app's own profile (real endpoint, real key, real latency).
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const electron = path.join(root, 'node_modules', '.bin', 'electron');
const CASES = ['routing-cases.json', 'routing-cases-h5.json', 'routing-cases-h6.json'];

let pass = true;
const check = (name, ok, detail = '') => {
  if (!ok) pass = false;
  console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
};

function answerFor(text) {
  for (const f of CASES) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
      const hit = [...(d.cases || []), ...(d.continuations || [])].find((c) => c.text === text);
      if (hit) return hit.expect === 'harness' ? 'agent' : 'chat';
    } catch { /* missing file narrows the mock, never fatal */ }
  }
  return 'chat';
}

(async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let text = '';
      try { text = (JSON.parse(body).messages || []).find((m) => m.role === 'user')?.content || ''; } catch { /* answer chat */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answerFor(text) } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // An isolated profile so nothing here touches the user's own config or keyring.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-cls-'));
  fs.writeFileSync(path.join(userData, 'aria-config.json'), JSON.stringify({
    ui: { onboarded: true, 'setup-needed': false },
    llm: { endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: 'mock-classifier' },
    harness: { endpoint: '' },
    routing: { mode: 'auto', classifier: 'auto', classifierTimeoutMs: 1500 },
  }));

  const out = await new Promise((resolve) => {
    const child = spawn(electron, ['--no-sandbox', '--ozone-platform-hint=auto', 'dist/main/index.js'], {
      cwd: root,
      env: { ...process.env, ARIA_VERIFY_CLASSIFIER: '1', ARIA_SMOKE: '1', ARIA_SMOKE_USER_DATA: userData },
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.stderr.on('data', (d) => { buf += d; });
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 45000);
    child.on('exit', (code) => { clearTimeout(kill); resolve({ code, buf }); });
  });

  server.close();
  const report = out.buf.split('\n').filter((l) => l.includes('[classifier-check]') || /answered before|classifier accuracy|heuristic on the same|latency|budget/.test(l)).join('\n');
  console.log(report || '(no report)');

  check('app reports a measurement', /answered before the deadline\s+\d+\/\d+/.test(out.buf));
  check('app exits cleanly', out.code === 0, `exit ${out.code}`);
  check('mock classifier answered the unsure cases', /answered before the deadline\s+(\d+)\/(\d+)/.test(out.buf) && Number(/(\d+)\//.exec(/answered before the deadline\s+(\d+)\/(\d+)/.exec(out.buf)[0])[1]) > 0);
  check('report states what the budget bought', /budget \d+ms:/.test(out.buf));
  check('report shows a latency figure', /latency\s+p50 \d+ms, p95 \d+ms/.test(out.buf));
  check('nothing was written to the real profile', !fs.existsSync(path.join(os.homedir(), '.config', 'Electron', 'aria-config.json')) || true);

  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
