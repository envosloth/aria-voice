#!/usr/bin/env node
/* Item 2 verification: the first-run setup guide can configure a DIRECT LLM
 * provider (user-supplied endpoint/key/model) with a working Test connection,
 * and that config is persisted — no need to open Settings afterward.
 *
 * Boots the real app headless in a fresh isolated --user-data-dir (so it starts
 * un-onboarded and never touches the user's config), drives the onboarding's new
 * direct-LLM step against a mock OpenAI-compatible endpoint, then reads back the
 * persisted config.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function makeServer() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

async function main() {
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-onb-'));
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');

  const child = spawn(electron, [
    '--no-sandbox', `--user-data-dir=${userDir}`,
    path.join(__dirname, '..', 'dist', 'main', 'index.js'),
  ], { env: { ...process.env, ARIA_SMOKE: '1', ARIA_VERIFY_ONBOARD: '1', ARIA_VERIFY_LLM_ENDPOINT: endpoint } });

  const marks = {};
  let buf = '';
  const onLine = (line) => {
    if (process.env.VERBOSE) console.log(line);
    const m = line.match(/\[ARIA_VERIFY\] ([a-z-]+)=(.*)$/);
    if (m) { marks[m[1]] = m[2]; console.log('  ' + line.trim()); }
  };
  const pump = (d) => { buf += d.toString(); const ls = buf.split('\n'); buf = ls.pop(); ls.forEach(onLine); };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);

  await new Promise((r) => child.on('exit', r));
  server.close();
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}

  const checks = [
    ['onboarding has direct-LLM step', marks['onboarding-has-direct-llm-step'] === 'true'],
    ['test connection succeeded', /Connected/.test(marks['llm-test-result'] || '')],
    ['llm.endpoint persisted', marks['persisted-llm-endpoint'] === endpoint],
    ['llm.model persisted', marks['persisted-llm-model'] === 'mock-model'],
    ['llm api key persisted', marks['persisted-llm-key'] === 'set'],
    ['ui.onboarded set', marks['onboarded'] === 'true'],
  ];
  let pass = true;
  console.log('\nChecks:');
  for (const [name, ok] of checks) { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); pass = pass && ok; }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
