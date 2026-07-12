#!/usr/bin/env node
/* Regression tests for renderer mic startup single-flight and recovery. */

const { MicStartupGate } = require('../src/renderer/mic-lifecycle.js');
const fs = require('fs');
const path = require('path');

let pass = true;
function check(name, condition, detail) {
  if (!condition) pass = false;
  console.log(`[${name}] ${condition ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const copier = fs.readFileSync(path.join(__dirname, 'copy-renderer.js'), 'utf8');
  check('renderer-build-copies-mic-lifecycle', copier.includes("'mic-lifecycle.js'"));
  const gate = new MicStartupGate();
  let starts = 0;
  let cleanups = 0;
  const resource = async () => {
    starts++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return () => { cleanups++; };
  };
  await Promise.all([gate.start(resource), gate.start(resource), gate.start(resource)]);
  check('mic-start-is-single-flight', starts === 1, `starts=${starts}`);
  await gate.stop();
  check('mic-stop-cleans-active-graph', cleanups === 1, `cleanups=${cleanups}`);

  let failed = false;
  try { await gate.start(async () => { throw new Error('denied'); }); } catch { failed = true; }
  check('mic-startup-failure-surfaces', failed && !gate.started());
  await gate.start(resource);
  check('mic-recovers-after-failed-start', starts === 2 && gate.started(), `starts=${starts}`);
  await gate.stop();
  check('mic-recovery-cleans-up', cleanups === 2, `cleanups=${cleanups}`);

  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(2); });
