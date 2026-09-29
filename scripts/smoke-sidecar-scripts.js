#!/usr/bin/env node
/* Regression tests for the model/sidecar shell scripts (no network, no PyInstaller):
 *  - download-models.sh: an HTTP error must not be appended to a resumable
 *    .partial (curl --fail), so resume progress survives a transient 404/5xx.
 *  - package-sidecar.sh: NAME is allowlisted before any rm -rf, so a traversal
 *    name cannot delete outside build/sidecars. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
function check(name, cond, detail) {
  if (!cond) process.exitCode = 1;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
}

async function downloadFailKeepsPartial() {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html>404 Not Found</html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/model.bin`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-dl-'));
  const dest = path.join(tmp, 'model.bin');
  fs.writeFileSync(dest + '.partial', 'resumable-prefix');
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'download-models.sh'), 'utf8');
  const fn = src.match(/^download_with_resume\(\) \{[\s\S]*?^\}/m);
  check('download function found', !!fn);
  const script = `set -uo pipefail\n${fn ? fn[0] : ''}\n` +
    `download_with_resume "$1" "$2" "${'0'.repeat(64)}"; echo "rc=$?"\n`;
  const result = await new Promise((resolve) => {
    const child = spawn('bash', ['-c', script, 'x', url, dest], { env: { ...process.env, http_proxy: '', HTTP_PROXY: '' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(out));
  });
  server.close();
  const partial = fs.existsSync(dest + '.partial') ? fs.readFileSync(dest + '.partial', 'utf8') : null;
  check('download HTTP error returns failure', /rc=1/.test(result), result.trim().split('\n').pop());
  check('download HTTP error keeps resumable partial intact', partial === 'resumable-prefix', JSON.stringify(partial));
  check('download HTTP error never promotes', !fs.existsSync(dest));
  fs.rmSync(tmp, { recursive: true, force: true });
}

function packageNameAllowlist() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-pkg-'));
  const root = path.join(t, 'root');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build', 'sidecars'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sidecars', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(root, 'victim'), { recursive: true });
  fs.writeFileSync(path.join(root, 'victim', 'marker'), 'keep');
  fs.copyFileSync(path.join(REPO, 'scripts', 'package-sidecar.sh'), path.join(root, 'scripts', 'package-sidecar.sh'));
  // Satisfy the script's venv preconditions for the traversal target so only
  // the allowlist can stop it.
  const bin = path.join(t, 'victim', 'venv', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of ['pyinstaller', 'pip', 'python']) {
    fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, tool), 0o755);
  }
  const r = spawnSync('bash', [path.join(root, 'scripts', 'package-sidecar.sh'), '../../victim'], { encoding: 'utf8' });
  check('package-sidecar rejects traversal name', r.status !== 0, `status=${r.status}`);
  check('package-sidecar traversal cannot rm -rf outside build', fs.existsSync(path.join(root, 'victim', 'marker')));
  const bad = spawnSync('bash', [path.join(root, 'scripts', 'package-sidecar.sh'), 'nonsense'], { encoding: 'utf8' });
  check('package-sidecar rejects unknown name', bad.status === 2, `status=${bad.status} ${bad.stderr.trim()}`);
  fs.rmSync(t, { recursive: true, force: true });
}

(async () => {
  await downloadFailKeepsPartial();
  packageNameAllowlist();
  console.log(`\n=== RESULT: ${process.exitCode ? 'FAIL' : 'PASS'} ===`);
})().catch((e) => { console.error(e); process.exit(2); });
