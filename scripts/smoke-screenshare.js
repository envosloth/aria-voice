#!/usr/bin/env node
/* Item 7 reproduction/verification: activating screen share must not duplicate
 * the first message, and a message sent WHILE sharing must reach the model
 * attributed correctly (the screen image on the CURRENT user turn, not a stale
 * first message).
 *
 * Boots the real app headless, fakes getDisplayMedia with a canvas stream,
 * builds a real 2-turn history against a mock LLM, activates screen share, then
 * sends a message while sharing. The mock records every request's messages array.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const requests = []; // captured messages arrays, in order

function mockServer() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { requests.push(JSON.parse(body).messages); } catch (e) { requests.push(null); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok.' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
}

async function main() {
  const server = mockServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-ss-'));
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['--no-sandbox', `--user-data-dir=${userDir}`, path.join(__dirname, '..', 'dist', 'main', 'index.js')], {
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_VERIFY_SCREENSHARE: '1', ARIA_VERIFY_LLM_ENDPOINT: endpoint },
  });

  const marks = {};
  let buf = '';
  const onLine = (line) => {
    if (process.env.VERBOSE) console.log(line);
    const m = line.match(/\[ARIA_VERIFY\] ([a-z0-9-]+)=(.*)$/);
    if (m) { marks[m[1]] = m[2]; console.log('  ' + line.trim()); }
  };
  const pump = (d) => { buf += d.toString(); const ls = buf.split('\n'); buf = ls.pop(); ls.forEach(onLine); };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);

  await new Promise((r) => child.on('exit', r));
  server.close();
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}

  let before = []; let after = [];
  try { before = JSON.parse(marks['convo-before'] || '[]'); } catch (e) {}
  try { after = JSON.parse(marks['convo-after'] || '[]'); } catch (e) {}

  // The last request is the one sent while sharing. Inspect its final user turn.
  const lastReq = requests[requests.length - 1] || [];
  const lastUser = [...lastReq].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUser
    ? (typeof lastUser.content === 'string' ? lastUser.content
      : (Array.isArray(lastUser.content) ? (lastUser.content.find((p) => p.type === 'text') || {}).text : ''))
    : '';
  const lastUserHasImage = !!(lastUser && Array.isArray(lastUser.content) && lastUser.content.some((p) => p.type === 'image_url'));

  // Count duplicate user bubbles of the first user message text in the after-snapshot.
  const firstUserText = (before.find((m) => m.role === 'user') || {}).text || '';
  const dupFirstInAfter = after.filter((m) => m.role === 'user' && m.text === firstUserText).length;

  const userBubblesAfter = after.filter((m) => m.role === 'user').map((m) => m.text);

  const checks = [
    ['conversation built (>=2 user turns before share)', before.filter((m) => m.role === 'user').length >= 2],
    ['first user message not duplicated after share', dupFirstInAfter === 1],
    ['message sent while sharing routes its OWN text to the model', /describe my screen/.test(lastUserText)],
    ['screen image attached to the CURRENT user turn (not a stale one)', lastUserHasImage],
    ['no first-message text leaked as the latest user turn', lastUserText !== firstUserText],
  ];
  console.log('\n  last user turn sent to model:', JSON.stringify(lastUserText), 'image=' + lastUserHasImage);
  console.log('  user bubbles after share:', JSON.stringify(userBubblesAfter));
  let pass = true;
  console.log('\nChecks:');
  for (const [name, ok] of checks) { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); pass = pass && ok; }
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
