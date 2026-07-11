#!/usr/bin/env node
/* Release guard: Linux installers must contain a successfully staged whisper.cpp. */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const buildScript = fs.readFileSync(path.join(root, 'scripts', 'build-whispercpp.sh'), 'utf8');

let pass = true;
function check(name, condition, detail) {
  if (!condition) pass = false;
  console.log(`[${name}] ${condition ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
}

const installLine = workflow.split('\n').find((line) => line.includes('apt-get install')) || '';
check('linux-installs-glslc', /\bglslc\b/.test(installLine), installLine.trim());
check('whisper-build-is-release-fatal', !/build-whispercpp\.sh\s*\|\|/.test(workflow));
check('whisper-stage-is-release-fatal', !/stage-whisper\.sh\s*\|\|/.test(workflow));
check('linux-build-preflight-requires-glslc', /REQUIRED=\([^\n]*glslc[^\n]*\)/.test(buildScript));

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
