#!/usr/bin/env node
/* Latency baseline runner for the LLM hot path (Item 0 harness).
 *
 * Drives the REAL streamChat() against a mock OpenAI-compatible SSE server whose
 * time-to-first-token (TTFT) and inter-token gap are tunable, so we can capture
 * the same stage breakdown the in-app [ARIA_PERF] marks record:
 *
 *     llm_request -> first_token -> llm_done
 *
 * These are the exact boundaries coordinator.ts marks in the live app. The mock
 * TTFT values EMULATE provider behavior (a fast local server vs. a slower remote)
 * so the breakdown shows where time goes; real provider numbers come from a live
 * run with ARIA_PERF=1 (see RALPH_PROGRESS.md "How to capture a live baseline").
 *
 * Usage: node scripts/perf-baseline.js
 */
const http = require('http');
const { streamChat } = require('../dist/main/llm-stream');

// Mock SSE server: ?ttft=<ms before first token>&gap=<ms between tokens>&n=<tokens>
function makeServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const ttft = Number(u.searchParams.get('ttft') || 50);
    const gap = Number(u.searchParams.get('gap') || 12);
    const n = Number(u.searchParams.get('n') || 30);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let i = 0;
    const sendOne = () => {
      if (i < n) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'word ' } }] })}\n\n`);
        i++;
        setTimeout(sendOne, gap);
      } else {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    };
    setTimeout(sendOne, ttft); // first token only after TTFT
  });
}

function runOne(base, scenario) {
  return new Promise((resolve) => {
    const ep = `${base}/v1/chat/completions?ttft=${scenario.ttft}&gap=${scenario.gap}&n=${scenario.n}`;
    const t0 = Date.now();
    let tFirst = null;
    streamChat({ endpoint: ep, model: 'mock', message: 'hi' }, {
      onToken: () => { if (tFirst === null) tFirst = Date.now(); },
      onDone: () => {
        const tDone = Date.now();
        resolve({
          name: scenario.name,
          ttft: tFirst - t0,           // request -> first token (network + model TTFT)
          stream: tDone - (tFirst || t0), // first token -> completion (streaming)
          total: tDone - t0,
        });
      },
      onError: (e) => resolve({ name: scenario.name, error: e }),
    });
  });
}

async function main() {
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const scenarios = [
    { name: 'local-fast   (TTFT 40ms)',  ttft: 40,  gap: 10, n: 30 },
    { name: 'remote-typ.  (TTFT 350ms)', ttft: 350, gap: 18, n: 40 },
    { name: 'remote-slow  (TTFT 800ms)', ttft: 800, gap: 25, n: 50 },
  ];

  console.log('=== ARIA LLM latency baseline (streamChat) ===');
  console.log('scenario                 | req->1st tok | 1st tok->done |   total');
  console.log('-------------------------+--------------+---------------+--------');
  for (const s of scenarios) {
    // average of 3 runs to smooth jitter
    const runs = [];
    for (let k = 0; k < 3; k++) runs.push(await runOne(base, s));
    if (runs[0].error) { console.log(`${s.name} ERROR: ${runs[0].error}`); continue; }
    const avg = (key) => Math.round(runs.reduce((a, r) => a + r[key], 0) / runs.length);
    console.log(
      `${s.name.padEnd(24)} | ${String(avg('ttft') + 'ms').padStart(12)} | ` +
      `${String(avg('stream') + 'ms').padStart(13)} | ${String(avg('total') + 'ms').padStart(6)}`,
    );
  }
  server.close();
  console.log('\nNote: time-to-first-token dominates perceived latency; the app starts');
  console.log('rendering text AND speaking on the first token (streaming), so user-visible');
  console.log('latency tracks "req->1st tok", not "total".');
}

main().catch((e) => { console.error(e); process.exit(1); });
