// In-app updates.
//
// ARIA is delivered two ways, which update differently:
//   • AppImage  -> self-updating. electron-updater downloads the new release in
//     the background and, on the user's click, swaps the AppImage and relaunches.
//   • .deb/dev  -> apt/dpkg owns the install, so we can't self-install. We fall
//     back to a GitHub Releases version check and surface "an update is available"
//     with a link to the release page / installer.
//
// Either way the renderer drives it through one bridge (aria.updates) and reacts
// to UPDATE_STATUS events. electron-updater is required lazily so the dependency
// is only loaded on the AppImage path (and a require failure degrades to notify).

import { app, BrowserWindow, shell } from 'electron';
import https from 'https';
import path from 'path';
import { IPC } from '../shared/ipc-channels';

const REPO_OWNER = 'envosloth';
const REPO_NAME = 'aria-voice';
const RELEASES_LATEST_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

export type UpdateChannel = 'appimage' | 'deb' | 'dev';

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error';
  current: string;          // running app version
  version?: string;         // the available/newer version (no leading "v")
  notes?: string;           // release notes (notify path)
  url?: string;             // release page url
  percent?: number;         // download progress 0..100 (AppImage)
  message?: string;         // error detail
  canAutoInstall?: boolean; // true when electron-updater can install it (AppImage)
}

let win: BrowserWindow | null = null;
let autoUpdater: import('electron-updater').AppUpdater | null = null;
let beforeInstall: (() => Promise<void>) | null = null;
let installing = false;
let downloadedVersion: string | null = null;

/** Which install medium are we running as — decides auto-install vs notify. */
export function deliveryChannel(): UpdateChannel {
  if (!app.isPackaged) return 'dev';
  if (process.env.APPIMAGE) return 'appimage';
  return 'deb';
}

export function currentVersion(): string {
  // app.getVersion() returns ELECTRON's version in an unpackaged dev run (it only
  // reflects the app's version once packaged). Read the app's package.json — which
  // ships inside the asar — so the Updates panel shows ARIA's version everywhere.
  try {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    if (pkg && pkg.version) return pkg.version as string;
  } catch { /* fall through */ }
  return app.getVersion();
}

/** True while an AppImage install+relaunch is in flight, so the app's before-quit
 *  handler lets electron-updater drive the quit instead of hard-exiting. */
export function isInstallingUpdate(): boolean {
  return installing;
}

function emit(s: Partial<UpdateStatus> & { state: UpdateStatus['state'] }): void {
  const full: UpdateStatus = { current: currentVersion(), ...s };
  try { win?.webContents.send(IPC.UPDATE_STATUS, full); } catch { /* window gone */ }
}

// Parse "v2.1.0" / "2.1.0-beta.1" -> [2,1,0]; pre-release suffixes are ignored
// for the comparison (a tagged release is what we compare against).
function parseVersion(v: string): number[] {
  const m = String(v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** True if `remote` is a strictly newer version than `current`. Exported for tests. */
export function isNewer(remote: string, current: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// Minimal GitHub Releases "latest" fetch — no token (public repo), with the
// User-Agent the API requires. Returns the parsed tag/notes/url or throws.
function fetchLatestRelease(): Promise<{ version: string; notes: string; url: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
        method: 'GET',
        headers: {
          'User-Agent': `ARIA/${currentVersion()}`,
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const j = JSON.parse(body);
              resolve({
                version: String(j.tag_name || '').replace(/^v/i, ''),
                notes: typeof j.body === 'string' ? j.body : '',
                url: j.html_url || RELEASES_LATEST_PAGE,
              });
            } catch (e) {
              reject(new Error('Could not parse GitHub response'));
            }
          } else {
            reject(new Error(`GitHub returned ${res.statusCode}`));
          }
        });
      },
    );
    req.on('error', (e) => reject(e));
    req.setTimeout(10000, () => { req.destroy(new Error('GitHub request timed out')); });
    req.end();
  });
}

/**
 * Wire the updater to a window. `beforeInstall` is run (e.g. to stop sidecars)
 * right before an AppImage install+relaunch so no child processes are orphaned.
 */
export function initUpdater(window: BrowserWindow, opts: { beforeInstall?: () => Promise<void> } = {}): void {
  win = window;
  beforeInstall = opts.beforeInstall || null;

  if (deliveryChannel() !== 'appimage') return; // notify-only path needs no autoUpdater

  try {
    // Lazy require so non-AppImage builds never load it.
    const mod = require('electron-updater') as typeof import('electron-updater');
    autoUpdater = mod.autoUpdater;
    autoUpdater.autoDownload = true;          // fetch in the background once found
    autoUpdater.autoInstallOnAppQuit = false; // we install explicitly on the user's click
    autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => emit({ state: 'available', version: info.version, canAutoInstall: true }));
    autoUpdater.on('update-not-available', () => emit({ state: 'not-available' }));
    autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      downloadedVersion = info.version;
      emit({ state: 'downloaded', version: info.version, canAutoInstall: true });
    });
    autoUpdater.on('error', (err) => emit({ state: 'error', message: (err && err.message) || String(err) }));
  } catch (e) {
    autoUpdater = null; // fall back to notify path
  }
}

/** Check for a newer release. AppImage uses electron-updater; others use the API. */
export async function checkForUpdates(): Promise<void> {
  emit({ state: 'checking' });
  if (autoUpdater) {
    try { await autoUpdater.checkForUpdates(); }
    catch (e) { emit({ state: 'error', message: (e as Error).message }); }
    return;
  }
  // Notify-only path (.deb / dev): compare the latest release tag to our version.
  try {
    const rel = await fetchLatestRelease();
    if (isNewer(rel.version, currentVersion())) {
      emit({ state: 'available', version: rel.version, notes: rel.notes, url: rel.url, canAutoInstall: false });
    } else {
      emit({ state: 'not-available' });
    }
  } catch (e) {
    emit({ state: 'error', message: (e as Error).message });
  }
}

/** Install a downloaded AppImage update and relaunch. No-op off the AppImage path. */
export async function installUpdate(): Promise<void> {
  if (!autoUpdater || !downloadedVersion) return;
  installing = true;
  try { if (beforeInstall) await beforeInstall(); } catch { /* best effort cleanup */ }
  // Defer so this IPC handler returns before the app tears down.
  setImmediate(() => {
    try { autoUpdater!.quitAndInstall(false, true); }
    catch (e) { installing = false; emit({ state: 'error', message: (e as Error).message }); }
  });
}

/** Open the latest-release page in the user's browser (notify path's CTA). */
export function openReleasePage(url?: string): void {
  void shell.openExternal(url || RELEASES_LATEST_PAGE);
}
