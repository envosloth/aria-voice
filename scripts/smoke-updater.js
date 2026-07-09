#!/usr/bin/env node
/* Unit test for the updater's pure decision logic. These gates decide whether a
 * GitHub release is offered and whether Linux should use .deb or .rpm handling,
 * so they must stay deterministic outside Electron. The rest of updater.ts
 * (electron-updater wiring, IPC) is exercised by the boot test. */
const { isNewer, linuxPackageChannel, releaseAssetForChannel } = require('../dist/main/updater');

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

// Linux package channel selection. Fedora/RHEL/openSUSE installs are rpm-owned;
// offering a .deb + dpkg/pkexec path there is the reported Fedora updater bug.
check('linux fedora -> rpm', linuxPackageChannel('ID=fedora\nID_LIKE="rhel fedora"\n'), 'rpm');
check('linux rhel-like -> rpm', linuxPackageChannel('ID=rocky\nID_LIKE="rhel centos fedora"\n'), 'rpm');
check('linux opensuse -> rpm', linuxPackageChannel('ID=opensuse-tumbleweed\n'), 'rpm');
check('linux ubuntu -> deb', linuxPackageChannel('ID=ubuntu\nID_LIKE=debian\n'), 'deb');
check('linux unknown -> deb', linuxPackageChannel(''), 'deb');

const assets = [
  { name: 'ARIA-2.14.0-x86_64.AppImage', url: 'https://example.invalid/appimage' },
  { name: 'aria_2.14.0_amd64.deb', url: 'https://example.invalid/deb' },
  { name: 'aria-2.14.0.x86_64.rpm', url: 'https://example.invalid/rpm' },
];
check('release asset deb', releaseAssetForChannel(assets, 'deb')?.url, 'https://example.invalid/deb');
check('release asset rpm', releaseAssetForChannel(assets, 'rpm')?.url, 'https://example.invalid/rpm');
check('release asset dev none', releaseAssetForChannel(assets, 'dev'), undefined);

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
