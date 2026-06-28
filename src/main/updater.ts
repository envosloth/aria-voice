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
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { IPC } from '../shared/ipc-channels';

const REPO_OWNER = 'envosloth';
const REPO_NAME = 'aria-voice';
const RELEASES_LATEST_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

export type UpdateChannel = 'appimage' | 'deb' | 'win' | 'mac' | 'dev';

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'not-available' | 'error';
  current: string;          // running app version
  version?: string;         // the available/newer version (no leading "v")
  notes?: string;           // release notes (notify path)
  url?: string;             // release page url
  percent?: number;         // download progress 0..100
  message?: string;         // error detail
  canAutoInstall?: boolean; // true when ARIA can install it itself (electron-updater on AppImage/Windows/macOS, or .deb via pkexec)
}

interface DebInfo { version: string; url: string; sha512?: string; }

let win: BrowserWindow | null = null;
let autoUpdater: import('electron-updater').AppUpdater | null = null;
let beforeInstall: (() => Promise<void>) | null = null;
let installing = false;
let downloadedVersion: string | null = null;
// The .deb to install on the next install() click (set when a check finds a newer
// release on the .deb channel). Holds the direct asset URL + expected sha512.
let pendingDeb: DebInfo | null = null;

/** Which install medium are we running as — decides auto-install vs notify. */
export function deliveryChannel(): UpdateChannel {
  if (!app.isPackaged) return 'dev';
  // Windows (NSIS) and macOS (dmg/zip) self-update through electron-updater,
  // same as the Linux AppImage. Checked before APPIMAGE so the Linux branches
  // below stay linux-only and unchanged.
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  if (process.env.APPIMAGE) return 'appimage';
  return 'deb';
}

/** Channels whose installer is driven by electron-updater (vs. the .deb/notify path). */
function usesElectronUpdater(): boolean {
  const ch = deliveryChannel();
  return ch === 'appimage' || ch === 'win' || ch === 'mac';
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
interface ReleaseAsset { name: string; url: string }
function fetchLatestRelease(): Promise<{ version: string; notes: string; url: string; assets: ReleaseAsset[] }> {
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
              const assets: ReleaseAsset[] = Array.isArray(j.assets)
                ? j.assets.map((a: any) => ({ name: String(a.name || ''), url: String(a.browser_download_url || '') }))
                : [];
              resolve({
                version: String(j.tag_name || '').replace(/^v/i, ''),
                notes: typeof j.body === 'string' ? j.body : '',
                url: j.html_url || RELEASES_LATEST_PAGE,
                assets,
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

// GET a URL following redirects (GitHub asset URLs 302 to a CDN). `onData` gets
// each chunk; resolves on completion. Used for both the small yml manifest and
// the large .deb download.
function httpGet(url: string, onData: (chunk: Buffer) => void, redirectsLeft = 5): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.get(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'User-Agent': `ARIA/${currentVersion()}` } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          httpGet(new URL(res.headers.location, url).toString(), onData, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${u.pathname}`));
          return;
        }
        res.on('data', onData);
        res.on('end', () => resolve({ statusCode: res.statusCode! }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('download timed out')));
  });
}

// Read the published latest-linux.yml so we know the .deb's expected sha512 (the
// same integrity source electron-updater uses for the AppImage). Best-effort:
// returns null if it can't be fetched/parsed (we just skip the checksum then).
async function fetchDebSha512(debName: string): Promise<string | null> {
  try {
    let body = '';
    await httpGet(`https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/latest-linux.yml`,
      (c) => { body += c.toString(); });
    // Find the "- url: <debName>" block and the sha512 line under it.
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(debName)) {
        for (let j = i; j < Math.min(i + 4, lines.length); j++) {
          const m = lines[j].match(/sha512:\s*(\S+)/);
          if (m) return m[1];
        }
      }
    }
  } catch { /* skip checksum */ }
  return null;
}

/**
 * Wire the updater to a window. `beforeInstall` is run (e.g. to stop sidecars)
 * right before an AppImage install+relaunch so no child processes are orphaned.
 */
export function initUpdater(window: BrowserWindow, opts: { beforeInstall?: () => Promise<void> } = {}): void {
  win = window;
  beforeInstall = opts.beforeInstall || null;

  if (!usesElectronUpdater()) return; // .deb/dev notify-only path needs no autoUpdater

  try {
    // Lazy require so the .deb/dev builds never load it.
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
  // .deb / dev path: compare the latest release tag to our version.
  try {
    const rel = await fetchLatestRelease();
    if (!isNewer(rel.version, currentVersion())) {
      emit({ state: 'not-available' });
      return;
    }
    // On a .deb install we CAN now self-install: find the .deb asset, remember it
    // (+ its checksum), and advertise the update as one-click installable. On dev
    // there's nothing to install, so it stays a notify-with-link.
    const isDeb = deliveryChannel() === 'deb';
    const debAsset = isDeb ? rel.assets.find((a) => /_amd64\.deb$/.test(a.name)) : undefined;
    if (isDeb && debAsset) {
      const sha512 = await fetchDebSha512(debAsset.name);
      pendingDeb = { version: rel.version, url: debAsset.url, sha512: sha512 || undefined };
      emit({ state: 'available', version: rel.version, notes: rel.notes, url: rel.url, canAutoInstall: true });
    } else {
      pendingDeb = null;
      emit({ state: 'available', version: rel.version, notes: rel.notes, url: rel.url, canAutoInstall: false });
    }
  } catch (e) {
    emit({ state: 'error', message: (e as Error).message });
  }
}

/**
 * Install the available update and relaunch. AppImage uses electron-updater's
 * downloaded artifact; .deb downloads the new package, verifies it, and installs
 * it with pkexec (a graphical password prompt) — so one click updates either way.
 */
export async function installUpdate(): Promise<void> {
  if (autoUpdater && downloadedVersion) {
    installing = true;
    try { if (beforeInstall) await beforeInstall(); } catch { /* best effort cleanup */ }
    setImmediate(() => {
      try { autoUpdater!.quitAndInstall(false, true); }
      catch (e) { installing = false; emit({ state: 'error', message: (e as Error).message }); }
    });
    return;
  }
  if (pendingDeb) { await installDebUpdate(pendingDeb); return; }
  emit({ state: 'error', message: 'No installable update is available.' });
}

// Download the new .deb (with progress + checksum), then install via pkexec and
// relaunch. pkexec shows the desktop's polkit password dialog; if the user
// cancels or it's unavailable, we surface an error and the app keeps running.
async function installDebUpdate(deb: DebInfo): Promise<void> {
  const dest = path.join(os.tmpdir(), deb.url.split('/').pop() || `aria-${deb.version}.deb`);
  const hash = crypto.createHash('sha512');
  let received = 0;
  // The deb asset is ~210MB; GitHub doesn't always send content-length through the
  // CDN redirect, so report progress against the known release size when present.
  emit({ state: 'downloading', version: deb.version, percent: 0 });
  try {
    const out = fs.createWriteStream(dest);
    await httpGet(deb.url, (chunk) => {
      received += chunk.length;
      hash.update(chunk);
      out.write(chunk);
      // ~211MB; coarse percent so the bar moves without a content-length header.
      emit({ state: 'downloading', version: deb.version, percent: Math.min(99, Math.round((received / 211_200_000) * 100)) });
    });
    await new Promise<void>((r) => out.end(r));
  } catch (e) {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    emit({ state: 'error', message: `Download failed: ${(e as Error).message}` });
    return;
  }
  if (deb.sha512 && hash.digest('base64') !== deb.sha512) {
    try { fs.unlinkSync(dest); } catch { /* ignore */ }
    emit({ state: 'error', message: 'Downloaded update failed its integrity check; not installing.' });
    return;
  }
  emit({ state: 'downloaded', version: deb.version });

  // Install with elevated privileges, fixing any dependencies, then relaunch.
  emit({ state: 'installing', version: deb.version });
  installing = true;
  try { if (beforeInstall) await beforeInstall(); } catch { /* best effort cleanup */ }
  const script = `dpkg -i '${dest.replace(/'/g, "'\\''")}' || apt-get -y -f install`;
  const child = spawn('pkexec', ['sh', '-c', script], { stdio: 'ignore' });
  child.on('error', (e) => {
    installing = false;
    emit({ state: 'error', message: `Couldn't launch the installer (${e.message}). Use "View release" to update manually.` });
  });
  child.on('exit', (code) => {
    if (code === 0) {
      emit({ state: 'installed', version: deb.version });
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      setImmediate(() => { app.relaunch(); app.exit(0); });
    } else {
      installing = false;
      // 126 = polkit auth dismissed/denied.
      const why = code === 126 ? 'cancelled at the password prompt' : `failed (exit ${code})`;
      emit({ state: 'error', message: `Update ${why}. You can try again or use "View release".` });
    }
  });
}

/** Open the latest-release page in the user's browser (notify path's CTA). */
export function openReleasePage(url?: string): void {
  void shell.openExternal(url || RELEASES_LATEST_PAGE);
}
