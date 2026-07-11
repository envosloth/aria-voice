#!/usr/bin/env node
/* Release guard: Linux installers must contain a successfully staged whisper.cpp. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const buildScript = fs.readFileSync(path.join(root, 'scripts', 'build-whispercpp.sh'), 'utf8');
const builderConfig = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');

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
check('mac-arm64-build-is-native', /os:\s*macos-15[\s\S]{0,160}target:\s*--mac --arm64/.test(workflow));
check('mac-x64-build-is-native', /os:\s*macos-15-intel[\s\S]{0,160}target:\s*--mac --x64/.test(workflow));
check('mac-targets-do-not-cross-package-native-resources', !/arch:\s*\[arm64,\s*x64\]/.test(builderConfig));
check('mac-update-metadata-is-merged', /merge-mac-update-metadata\.js/.test(workflow));
check('mac-disables-broken-native-probe', /Darwin\)[\s\S]{0,600}-DGGML_NATIVE=OFF/.test(buildScript));

// Separate native mac jobs emit separate updater manifests. The finalizer must
// merge both architectures into one latest-mac.yml.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-mac-meta-'));
const armDir = path.join(tmp, 'arm64');
const x64Dir = path.join(tmp, 'x64');
fs.mkdirSync(armDir); fs.mkdirSync(x64Dir);
for (const [dir, names] of [
  [armDir, ['ARIA-3.0.4-arm64-mac.zip', 'ARIA-3.0.4-arm64.dmg']],
  [x64Dir, ['ARIA-3.0.4-mac.zip', 'ARIA-3.0.4.dmg']],
]) for (const name of names) fs.writeFileSync(path.join(dir, name), name);
const mergedPath = path.join(tmp, 'latest-mac.yml');
try {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'merge-mac-update-metadata.js'), armDir, x64Dir, mergedPath]);
  const merged = fs.readFileSync(mergedPath, 'utf8');
  check('mac-metadata-lists-both-architectures',
    ['arm64-mac.zip', '3.0.4-mac.zip', 'arm64.dmg', '3.0.4.dmg'].every((name) => merged.includes(name)));
  check('mac-metadata-prefers-native-arm-update', /path: ARIA-3\.0\.4-arm64-mac\.zip/.test(merged));
} catch (err) {
  check('mac-metadata-lists-both-architectures', false, err.message.split('\n')[0]);
  check('mac-metadata-prefers-native-arm-update', false);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
