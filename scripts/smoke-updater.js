#!/usr/bin/env node
/* Unit test for the updater's version comparison (src/main/updater.ts isNewer).
 * This is the gate that decides whether a GitHub release is offered as an update,
 * so getting the numeric (not lexical) semver compare right matters. The rest of
 * updater.ts (electron-updater wiring, IPC) is exercised by the boot test. */
const { isNewer } = require('../dist/main/updater');

let pass = true;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) pass = false;
  console.log(`[${name}] ${got}${ok ? ' == ' : ' != '}${want} -> ${ok ? 'PASS' : 'FAIL'}`);
}

// Newer in each position
check('patch newer', isNewer('2.1.1', '2.1.0'), true);
check('minor newer', isNewer('2.2.0', '2.1.0'), true);
check('major newer', isNewer('3.0.0', '2.9.9'), true);
// Equal / older
check('equal', isNewer('2.1.0', '2.1.0'), false);
check('patch older', isNewer('2.0.9', '2.1.0'), false);
check('major older', isNewer('1.9.9', '2.0.0'), false);
// Numeric, not lexical (the classic "2.10 < 2.9" bug)
check('numeric minor 2.10 > 2.9', isNewer('2.10.0', '2.9.0'), true);
check('numeric patch 2.1.10 > 2.1.9', isNewer('2.1.10', '2.1.9'), true);
// Leading "v" tolerated (GitHub tags are vX.Y.Z)
check('leading v', isNewer('v2.2.0', '2.1.0'), true);
check('both leading v equal', isNewer('v2.1.0', 'v2.1.0'), false);
// Pre-release suffix ignored (compares the release base)
check('prerelease == base', isNewer('2.1.0-beta.1', '2.1.0'), false);
// Garbage degrades to 0.0.0 (never falsely offers an update)
check('garbage remote', isNewer('not-a-version', '2.1.0'), false);

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
