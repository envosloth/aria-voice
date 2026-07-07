#!/usr/bin/env node
// Static regression checks for renderer stability behaviours that are hard to
// trigger deterministically in headless Electron. These guard the "app flashes
// and resets when the agent responds" class of bugs: a transient Electron
// unresponsive signal must not immediately reload the renderer and wipe the UI.

const fs = require('fs');
const path = require('path');

let pass = true;
function check(name, cond, detail) {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL' + (detail ? ' -> ' + detail : '')}`);
}

const mainPath = path.join(__dirname, '..', 'src', 'main', 'index.ts');
const main = fs.readFileSync(mainPath, 'utf8');

check('unresponsive.graceTimer', /rendererUnresponsiveTimer\s*=\s*setTimeout/.test(main) && /15000/.test(main));
check('unresponsive.responsiveCancels', /win\.on\('responsive',\s*clearRendererUnresponsiveTimer\)/.test(main));
check('unresponsive.closedCancels', /win\.on\('closed',\s*clearRendererUnresponsiveTimer\)/.test(main));
check('unresponsive.noImmediateReloadMessage', !/renderer unresponsive\s*[—-]\s*reloading/.test(main));
check('unresponsive.reloadStillExistsAfterGrace', /renderer still unresponsive\s*[—-]\s*reloading/.test(main));

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
