#!/usr/bin/env node
/* Live end-to-end latency baseline (Item 0 harness).
 *
 * Boots the REAL Electron app headless (ARIA_SMOKE=1) with ARIA_PERF=1, drives
 * one genuine text turn through the actual UI path (text box -> Enter ->
 * submitUserMessage -> IPC -> coordinate -> streamChat) against a local mock
 * SSE endpoint, then parses the unified [ARIA_PERF] timeline and prints a
 * stage-by-stage breakdown for that turn.
 *
 * This exercises the SAME instrumentation the app uses in normal operation; it
 * adds no separate measurement path. Real-provider numbers come from the same
 * marks in a live run (ARIA_PERF=1 npm run start, then `grep ARIA_PERF`).
 *
 * Usage: node scripts/perf-live.js [ttftMs]
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const TTFT = Number(process.argv[2] || 40);

function makeServer() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const toks = 'The current time is ten past four in the afternoon.'.split(' ');
    let i = 0;
    const send = () => {
      if (i < toks.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: toks[i] + ' ' } }] })}\n\n`);
        i++;
        setTimeout(send, 15);
      } else { res.write('data: [DONE]\n\n'); res.end(); }
    };
    setTimeout(send, TTFT);
  });
}

async function main() {
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;

  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, ['--no-sandbox', path.join(__dirname, '..', 'dist', 'main', 'index.js')], {
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_PERF: '1', ARIA_PERF_LIVE: endpoint },
  });

  const marks = [];
  const re = /\[ARIA_PERF\] turn=(\S+) stage=(\S+) t=(\d+) proc=(\S+)/;
  const onLine = (line) => {
    const m = line.match(re);
    if (m) marks.push({ turn: m[1], stage: m[2], t: Number(m[3]), proc: m[4] });
  };
  let buf = '';
  const pump = (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) onLine(l);
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);

  await new Promise((r) => child.on('exit', r));
  server.close();

  // Pick the text turn (has user_input). Order stages by time.
  const turns = {};
  for (const m of marks) (turns[m.turn] = turns[m.turn] || []).push(m);
  const turnId = Object.keys(turns).find((t) => turns[t].some((m) => m.stage === 'user_input'));
  if (!turnId) {
    console.log('No instrumented text turn captured. Raw marks:', marks.length);
    for (const m of marks) console.log(' ', m.stage, m.proc, m.t);
    process.exit(marks.length ? 0 : 1);
  }
  const stages = turns[turnId].sort((a, b) => a.t - b.t);
  const t0 = stages[0].t;
  console.log(`=== Live text-turn latency baseline (mock TTFT=${TTFT}ms) ===`);
  console.log('stage                  | t+ms  | proc');
  console.log('-----------------------+-------+--------');
  let prev = t0;
  for (const s of stages) {
    const rel = s.t - t0;
    const delta = s.t - prev;
    console.log(`${s.stage.padEnd(22)} | ${String(rel).padStart(5)} | ${s.proc}  (+${delta}ms)`);
    prev = s.t;
  }
  const first = stages.find((s) => s.stage === 'first_token_render');
  const userInput = stages.find((s) => s.stage === 'user_input');
  if (first && userInput) {
    console.log(`\nUser-visible time-to-first-text: ${first.t - userInput.t}ms (user_input -> first_token_render)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
