#!/usr/bin/env node
/* Unit test for the updater's pure decision logic. These gates decide whether a
 * GitHub release is offered and whether Linux should use .deb or .rpm handling,
 * so they must stay deterministic outside Electron. The rest of updater.ts
 * (electron-updater wiring, IPC) is exercised by the boot test. */
const fs = require('fs');
const path = require('path');
const {
  isNewer,
  linuxPackageChannel,
  releaseAssetForChannel,
  isTrustedElectronUpdateChannel,
  createPrivateDebDownload,
  privilegedDebInstallArgs,
  beginUpdateInstall,
  tryBeginUpdateOperation,
  endUpdateOperation,
} = require('../dist/main/updater');

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

// Unsigned desktop builds must be notify-only. AppImage is integrity-checked by
// electron-updater; Windows needs an embedded publisherName so that the NSIS
// updater can validate Authenticode before we claim one-click install.
check('appimage update is trusted', isTrustedElectronUpdateChannel('appimage'), true);
check('unsigned mac update is manual', isTrustedElectronUpdateChannel('mac'), false);
check('unsigned windows update is manual', isTrustedElectronUpdateChannel('win'), false);
check('signed windows update is trusted', isTrustedElectronUpdateChannel('win', 'publisherName: ARIA Project\n'), true);

// A .deb must never use a predictable /tmp filename. Create the actual staging
// file so permissions and exclusive creation are checked rather than inferred.
let debStage;
try {
  debStage = createPrivateDebDownload('3.0.5');
  const dirStat = fs.statSync(debStage.dir);
  const fileStat = fs.lstatSync(debStage.path);
  check('deb staging directory is private 0700', dirStat.mode & 0o777, 0o700);
  check('deb staging file is regular', fileStat.isFile(), true);
  check('deb staging file is private 0600', fileStat.mode & 0o777, 0o600);
  check('deb staging pathname is inside private random directory', path.dirname(debStage.path), debStage.dir);
  check('deb staging cannot reuse an existing pathname', (() => {
    try {
      fs.openSync(debStage.path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      return false;
    } catch (err) {
      return err && err.code === 'EEXIST';
    }
  })(), true);
} catch (err) {
  check('deb private staging setup', false, true);
} finally {
  if (debStage) {
    try { fs.closeSync(debStage.fd); } catch {}
    fs.rmSync(debStage.dir, { recursive: true, force: true });
  }
}

const sha512 = Buffer.alloc(64, 0xa5).toString('base64');
const install = privilegedDebInstallArgs('/tmp/aria-update-test/update.deb', sha512, '/opt/aria/deb-update-installer.sh');
check('deb privileged command is pkexec', install.command, 'pkexec');
check('deb privileged command invokes fixed helper directly', install.args[0], '/opt/aria/deb-update-installer.sh');
check('deb privileged command does not invoke a shell', install.args.includes('sh') || install.args.includes('-c'), false);
check('deb privileged command passes checksum as hex', install.args[1], 'a5'.repeat(64));
check('deb privileged command passes package as argument', install.args[2], '/tmp/aria-update-test/update.deb');
const helperSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'deb-update-installer.sh'), 'utf8');
check('deb helper copies into root-owned staging', /mktemp -d[\s\S]*cp -- "\$deb_path" "\$root_deb"/.test(helperSource), true);
check('deb helper hashes root-owned copy', /sha512sum -- "\$root_deb"/.test(helperSource), true);
check('deb helper resolves dependencies with apt', /apt-get[\s\S]*install[\s\S]*"\$root_deb"/.test(helperSource), true);

// Repeated install IPC requests must not start overlapping downloads or
// quiesce/install lifecycles. A failed operation releases the slot for retry.
check('first update operation acquires single-flight slot', tryBeginUpdateOperation(), true);
check('concurrent update operation is rejected', tryBeginUpdateOperation(), false);
endUpdateOperation();
check('update operation can retry after release', tryBeginUpdateOperation(), true);
endUpdateOperation();

// A failed/cancelled update must restore sidecars once, while a partial quiesce
// failure must also attempt restoration before surfacing the failure.
async function checkLifecycle() {
  const events = [];
  const restore = await beginUpdateInstall(
    async () => { events.push('quiesce'); },
    async () => { events.push('resume'); },
  );
  await restore();
  await restore();
  check('failed update resumes once', events.join(','), 'quiesce,resume');

  const partial = [];
  try {
    await beginUpdateInstall(
      async () => { partial.push('quiesce'); throw new Error('stop failed'); },
      async () => { partial.push('resume'); },
    );
  } catch {}
  check('partial quiesce failure resumes', partial.join(','), 'quiesce,resume');
}

checkLifecycle().then(() => {
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
