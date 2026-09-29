#!/usr/bin/env node
/* Release/packaging regression guard. This is small enough to run on every
 * release job and checks the properties that prevent bad artifacts. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const whisper = fs.readFileSync(path.join(root, 'scripts', 'build-whispercpp.sh'), 'utf8');
const sidecarPackager = fs.readFileSync(path.join(root, 'scripts', 'package-sidecar.sh'), 'utf8');
const modelDownloader = fs.readFileSync(path.join(root, 'scripts', 'download-models.sh'), 'utf8');
const settingsMarkup = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let pass = true;
function check(name, condition, detail) {
  if (!condition) pass = false;
  console.log(`[${name}] ${condition ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
}

// Validate release tags against both package metadata sources with a temporary
// mismatch: a tag-only check would let a stale lockfile ship.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-release-version-'));
try {
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '3.0.5' }));
  fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ version: '3.0.5', packages: { '': { version: '3.0.5' } } }));
  execFileSync(process.execPath, [path.join(root, 'scripts', 'validate-release-version.js'), 'v3.0.5', tmp]);
  check('release validator accepts matching tag/package/lock', true);
  fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ version: '3.0.4', packages: { '': { version: '3.0.4' } } }));
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'validate-release-version.js'), 'v3.0.5', tmp], { stdio: 'pipe' });
    check('release validator rejects stale lockfile', false);
  } catch {
    check('release validator rejects stale lockfile', true);
  }
} catch (err) {
  check('release version validator', false, err.message.split('\n')[0]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

check('release uses Node 22', /node-version:\s*22\b/.test(workflow));
check('release validates version before package', /validate-release-version\.js\s+"\$GITHUB_REF_NAME"/.test(workflow));
check('release runs build', /npm run build/.test(workflow));
check('release runs lint', /npm run lint/.test(workflow));
check('release runs typecheck', /npm run typecheck/.test(workflow));
check('release runs packaging guard', /npm run smoke:release-packaging/.test(workflow));
check('release audits Electron as well as production packages', /npm run audit:runtime/.test(workflow)
  && packageJson.scripts['audit:runtime'] === 'npm audit --audit-level=high');
check('Electron binary provisioned explicitly', /npm exec --no -- install-electron/.test(workflow));
check('native matrix never publishes releases', /--publish never/.test(workflow) && !/--publish onTagOrDraft/.test(workflow));
check('single release finalizer', /gh release create/.test(workflow) && /needs: build/.test(workflow));
check('release retains updater metadata artifacts', /dist-installers\/latest\*\.yml/.test(workflow) && /dist-installers\/\*\.blockmap/.test(workflow));
const provisionIndex = workflow.indexOf('ARIA_WAKEWORD_ONLY=1 bash scripts/download-models.sh');
const freezeIndex = workflow.indexOf('npm run package:sidecars');
check('release provisions wake-word ONNX assets', provisionIndex >= 0);
check('release provisions wake-word assets before freezing', provisionIndex >= 0 && provisionIndex < freezeIndex);
check('release boots the frozen wake-word sidecar', /ARIA_SIDECAR_DIR=.*build\/sidecars[\s\S]*smoke-supervisor\.js wakeword/.test(workflow));
check('model script supports Windows venv interpreters', /venv\/Scripts\/python(?:\.exe)?/.test(modelDownloader));
check('model script supports wake-word-only release provisioning', /ARIA_WAKEWORD_ONLY/.test(modelDownloader));
const advertisedWakewords = [...settingsMarkup.matchAll(/<option value="([^"]+)">[^<]+<\/option>/g)]
  .map((match) => match[1])
  .filter((value) => ['hey_jarvis', 'alexa', 'hey_mycroft', 'hey_marvin'].includes(value));
check('every advertised built-in wake word is provisioned', advertisedWakewords.every((name) => {
  const filename = `${name}_v0.1.onnx`;
  return modelDownloader.includes(filename);
}), `advertised=${advertisedWakewords.join(',')}`);

// electron-builder sends arbitrary FPM flags through deb.fpm, which is the
// supported way to encode dpkg Replaces/Conflicts for the legacy package.
check('deb replaces legacy aria-voice package', /deb:[\s\S]*?fpm:[\s\S]*?--replaces=aria-voice/.test(builder));
check('deb conflicts with legacy aria-voice package', /deb:[\s\S]*?fpm:[\s\S]*?--conflicts=aria-voice/.test(builder));
check('rpm Vulkan dependency uses portable SONAME', /rpm:[\s\S]*?depends:[\s\S]*?libvulkan\.so\.1\(\)\(64bit\)/.test(builder));
check('PyInstaller specs are kept in disposable build workpath', /--specpath "\$SIDECAR_DIR\/build\/spec"/.test(sidecarPackager));
check('PyInstaller work/spec directory is removed after freeze', /rm -rf "\$SIDECAR_DIR\/build"/.test(sidecarPackager));

// BUILD_DIR must never allow cleanup of /, the current directory, or a shallow
// top-level temporary path. Exercise the script's early guard before it needs
// network/Vulkan tooling.
for (const dangerous of ['/', '.', '/tmp', '/usr', '/etc', '/opt', '/var', process.env.HOME, root]) {
  try {
    execFileSync('bash', [path.join(root, 'scripts', 'build-whispercpp.sh')], {
      env: { ...process.env, BUILD_DIR: dangerous },
      stdio: 'pipe',
    });
    check(`whisper rejects dangerous BUILD_DIR ${dangerous}`, false);
  } catch (err) {
    check(`whisper rejects dangerous BUILD_DIR ${dangerous}`, /unsafe BUILD_DIR/i.test(String(err.stderr || '')));
  }
}
try {
  execFileSync('bash', [path.join(root, 'scripts', 'build-whispercpp.sh')], {
    env: { ...process.env, WHISPER_BUILD_ROOT: '/usr/local', BUILD_DIR: '/usr/local/whisper-build-existing' },
    stdio: 'pipe',
  });
  check('whisper rejects coordinated caller-controlled build root', false);
} catch (err) {
  check('whisper rejects coordinated caller-controlled build root', /unsafe BUILD_DIR/i.test(String(err.stderr || '')));
}
check('whisper cleanup contains build-dir guard', /unsafe BUILD_DIR/i.test(whisper));
check('whisper build directory is created privately', /mktemp -d/.test(whisper));
check('model script pins immutable revisions', !/\/resolve\/main/.test(modelDownloader));
check('model script verifies sha256 before promotion', /sha256sum\s+-c/.test(modelDownloader));

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-audio-fixture-'));
const explicitMissingVoice = path.join(fixtureDir, 'requested-voice.onnx');
try {
  fs.writeFileSync(path.join(fixtureDir, 'en_GB-alan-medium.onnx'), 'fallback must not be used');
  execFileSync('bash', [path.join(root, 'scripts', 'gen-test-audio.sh')], {
    env: { ...process.env, ARIA_MODELS_DIR: fixtureDir, ARIA_TEST_VOICE: explicitMissingVoice },
    stdio: 'pipe',
  });
  check('explicit missing test voice fails without fallback', false);
} catch (err) {
  const output = `${err.stdout || ''}${err.stderr || ''}`;
  check('explicit missing test voice fails without fallback', output.includes(`Voice model missing: ${explicitMissingVoice}`));
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
