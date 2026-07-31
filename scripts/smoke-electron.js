#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-smoke-userdata-'));
const xdgConfig = path.join(userData, 'xdg-config');
const xdgCache = path.join(userData, 'xdg-cache');
fs.mkdirSync(xdgConfig, { recursive: true });
fs.mkdirSync(xdgCache, { recursive: true });

let status = 1;
try {
  const electron = require('electron');
  const child = spawnSync(electron, [
    '--no-sandbox',
    `--user-data-dir=${userData}`,
    path.join(root, 'dist', 'main', 'index.js'),
  ], {
    cwd: root,
    env: {
      ...process.env,
      ARIA_SMOKE: '1',
      ARIA_SMOKE_USER_DATA: userData,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) console.error('[ARIA_SMOKE] Electron launch failed:', child.error.message);
  status = child.status == null ? 1 : child.status;
} finally {
  fs.rmSync(userData, { recursive: true, force: true });
}

process.exit(status);
