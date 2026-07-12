// In-app updates.
//
// ARIA is delivered through several package formats, which update differently:
//   • AppImage  -> self-updating. electron-updater downloads the new release in
//     the background and, on the user's click, swaps the AppImage and relaunches.
//   • .deb      -> apt/dpkg owns the install; ARIA can download + verify the .deb
//     and invoke pkexec/dpkg on the user's click.
//   • .rpm/dev/unsigned desktop -> distro/package manager or manual download owns
//     the install, so we do a GitHub Releases version check and link the release.
//
// Either way the renderer drives it through one bridge (aria.updates) and reacts
// to UPDATE_STATUS events. electron-updater is required lazily so the dependency
// is only loaded on trusted paths (and a require failure degrades to notify).

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

export type UpdateChannel = 'appimage' | 'deb' | 'rpm' | 'win' | 'mac' | 'dev';

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'not-available' | 'error';
  current: string;          // running app version
  version?: string;         // the available/newer version (no leading "v")
  notes?: string;           // release notes (notify path)
  url?: string;             // release page url
  percent?: number;         // download progress 0..100
  message?: string;         // error detail
  canAutoInstall?: boolean; // true when ARIA can install it itself (trusted AppImage/Windows, or verified .deb via pkexec)
}

interface DebInfo { version: string; url: string; sha512?: string; }

let win: BrowserWindow | null = null;
let autoUpdater: import('electron-updater').AppUpdater | null = null;
let beforeInstall: (() => Promise<void>) | null = null;
let afterInstallFailure: (() => Promise<void>) | null = null;
let restoreAfterFailedInstall: (() => Promise<void>) | null = null;
let installing = false;
let downloadedVersion: string | null = null;
// The .deb to install on the next install() click (set when a check finds a newer
// release on the .deb channel). Holds the direct asset URL + expected sha512.
let pendingDeb: DebInfo | null = null;

/** Which install medium are we running as — decides auto-install vs notify. */
export function deliveryChannel(): UpdateChannel {
  if (!app.isPackaged) return 'dev';
  // Checked before APPIMAGE so the Linux branches below stay linux-only.
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'mac';
  if (process.env.APPIMAGE) return 'appimage';
  return linuxPackageChannel();
}

/**
 * Best-effort Linux package owner detection. electron-builder installs .deb and
 * .rpm apps into very similar /opt layouts, so the safest discriminator is the
 * host distro family. Unknown Linux keeps the historical deb path rather than
 * disabling Ubuntu/Debian one-click updates.
 */
export function linuxPackageChannel(osReleaseText?: string): Extract<UpdateChannel, 'deb' | 'rpm'> {
  let text = osReleaseText;
  if (text === undefined) {
    try { text = fs.readFileSync('/etc/os-release', 'utf8'); }
    catch { text = ''; }
  }
  const ids = String(text).toLowerCase();
  if (/\b(fedora|rhel|centos|rocky|almalinux|ol|sles|suse|opensuse)\b/.test(ids)) return 'rpm';
  return 'deb';
}

/**
 * Electron-updater's Windows verifier only checks Authenticode when its update
 * metadata contains a publisherName. The current release configuration has no
 * signing identity, so Windows and unsigned macOS deliberately stay manual.
 */
export function isTrustedElectronUpdateChannel(channel: UpdateChannel, updateMetadata = ''): boolean {
  return channel === 'appimage'
    || (channel === 'win' && /^publisherName:\s*\S/m.test(updateMetadata));
}

function installedUpdateMetadata(): string {
  try { return fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8'); }
  catch { return ''; }
}

/** Channels whose installer is driven by electron-updater (vs. the .deb/notify path). */
function usesElectronUpdater(): boolean {
  return isTrustedElectronUpdateChannel(deliveryChannel(), installedUpdateMetadata());
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
export function releaseAssetForChannel(assets: ReleaseAsset[], channel: UpdateChannel): ReleaseAsset | undefined {
  if (channel === 'deb') return assets.find((a) => /_amd64\.deb$/i.test(a.name));
  if (channel === 'rpm') return assets.find((a) => /\.(x86_64|amd64)\.rpm$/i.test(a.name) || /\.rpm$/i.test(a.name));
  return undefined;
}

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
// same integrity source electron-updater uses for the AppImage). A missing or
// malformed value makes the update manual-only; it must never weaken integrity.
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

function sha512Base64ToHex(value: string): string | null {
  try {
    const digest = Buffer.from(value, 'base64');
    return digest.length === 64 && digest.toString('base64') === value ? digest.toString('hex') : null;
  } catch {
    return null;
  }
}

export interface DebDownload {
  dir: string;
  path: string;
  fd: number;
}

/** Create a private, unique staging file; it is never a shared /tmp pathname. */
export function createPrivateDebDownload(): DebDownload {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-update-'));
  try {
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'update.deb');
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
    const fd = fs.openSync(file, flags, 0o600);
    return { dir, path: file, fd };
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore cleanup failure */ }
    throw e;
  }
}

function removeDebDownload(stage: DebDownload): void {
  try { fs.rmSync(stage.dir, { recursive: true, force: true }); } catch { /* ignore cleanup failure */ }
}

function debInstallerPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'deb-update-installer.sh')
    : path.join(__dirname, '..', '..', 'assets', 'deb-update-installer.sh');
}

/** Fixed argv only: the privileged helper receives no interpolated shell code. */
export function privilegedDebInstallArgs(debPath: string, sha512: string, helper = debInstallerPath()): { command: string; args: string[] } {
  const sha512Hex = sha512Base64ToHex(sha512);
  if (!sha512Hex) throw new Error('Update metadata has an invalid SHA-512 checksum.');
  return { command: 'pkexec', args: [helper, sha512Hex, debPath] };
}

/**
 * Quiesce before an install and return an idempotent restoration action. Keeping
 * this small lifecycle primitive separate makes cancellation paths testable and
 * lets the actual installer retain one restore callback across async events.
 */
export async function beginUpdateInstall(
  quiesce?: (() => Promise<void>) | null,
  resume?: (() => Promise<void>) | null,
): Promise<() => Promise<void>> {
  let restored = false;
  try {
    await quiesce?.();
  } catch (e) {
    try { await resume?.(); } catch { /* preserve original quiesce error */ }
    throw e;
  }
  return async () => {
    if (restored) return;
    restored = true;
    await resume?.();
  };
}

async function prepareInstall(): Promise<boolean> {
  try {
    restoreAfterFailedInstall = await beginUpdateInstall(beforeInstall, afterInstallFailure);
    return true;
  } catch (e) {
    emit({ state: 'error', message: `Could not prepare update: ${(e as Error).message}` });
    return false;
  }
}

async function recoverFailedInstall(message: string): Promise<void> {
  installing = false;
  const restore = restoreAfterFailedInstall;
  restoreAfterFailedInstall = null;
  try { await restore?.(); } catch { /* the original install failure is primary */ }
  emit({ state: 'error', message });
}

/**
 * Wire the updater to a window. `beforeInstall` is run (e.g. to stop sidecars)
 * right before an AppImage install+relaunch so no child processes are orphaned.
 */
export function initUpdater(
  window: BrowserWindow,
  opts: { beforeInstall?: () => Promise<void>; afterInstallFailure?: () => Promise<void> } = {},
): void {
  win = window;
  beforeInstall = opts.beforeInstall || null;
  afterInstallFailure = opts.afterInstallFailure || null;

  if (!usesElectronUpdater()) return; // manual/.deb/.rpm paths need no autoUpdater

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
    autoUpdater.on('error', (err) => {
      void recoverFailedInstall((err && err.message) || String(err));
    });
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
  // .deb / .rpm / dev path: compare the latest release tag to our version.
  try {
    const rel = await fetchLatestRelease();
    if (!isNewer(rel.version, currentVersion())) {
      emit({ state: 'not-available' });
      return;
    }
    // On a .deb install we can self-install only when a valid checksum is
    // published. On rpm/dev we do NOT run
    // distro-specific package managers from ARIA; link the correct release asset
    // instead so Fedora never sees a broken dpkg/pkexec path.
    const channel = deliveryChannel();
    const isDeb = channel === 'deb';
    const debAsset = isDeb ? releaseAssetForChannel(rel.assets, 'deb') : undefined;
    if (isDeb && debAsset) {
      const sha512 = await fetchDebSha512(debAsset.name);
      if (sha512 && sha512Base64ToHex(sha512)) {
        pendingDeb = { version: rel.version, url: debAsset.url, sha512 };
        emit({ state: 'available', version: rel.version, notes: rel.notes, url: rel.url, canAutoInstall: true });
      } else {
        pendingDeb = null;
        emit({ state: 'available', version: rel.version, notes: rel.notes, url: rel.url, canAutoInstall: false });
      }
    } else {
      pendingDeb = null;
      const asset = releaseAssetForChannel(rel.assets, channel);
      emit({ state: 'available', version: rel.version, notes: rel.notes, url: asset?.url || rel.url, canAutoInstall: false });
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
    if (!await prepareInstall()) return;
    installing = true;
    setImmediate(() => {
      try { autoUpdater!.quitAndInstall(false, true); }
      catch (e) { void recoverFailedInstall((e as Error).message); }
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
  if (!deb.sha512) {
    emit({ state: 'error', message: 'Update metadata has no SHA-512 checksum; use "View release" to update manually.' });
    return;
  }
  let stage: DebDownload;
  try {
    stage = createPrivateDebDownload();
  } catch (e) {
    emit({ state: 'error', message: `Could not create secure update staging: ${(e as Error).message}` });
    return;
  }
  const hash = crypto.createHash('sha512');
  let received = 0;
  // The deb asset is ~210MB; GitHub doesn't always send content-length through the
  // CDN redirect, so report progress against the known release size when present.
  emit({ state: 'downloading', version: deb.version, percent: 0 });
  const out = fs.createWriteStream(stage.path, { fd: stage.fd, autoClose: true });
  try {
    // Fold the write stream's own 'error' (e.g. a full disk mid-download) into
    // the same rejection path as a network error. Without a listener, a
    // WriteStream 'error' is an uncaught exception that crashes the main
    // process mid-update instead of surfacing a clean "Download failed".
    await new Promise<void>((resolve, reject) => {
      // Resolve only on a genuine 'finish' (all bytes flushed) and reject on any
      // write 'error' — whichever fires first wins. Using out.end(resolve) here
      // would resolve even on a mid-download disk error, letting a truncated
      // .deb slip past to the install step.
      out.on('error', reject);
      out.on('finish', resolve);
      httpGet(deb.url, (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        out.write(chunk);
        // ~211MB; coarse percent so the bar moves without a content-length header.
        emit({ state: 'downloading', version: deb.version, percent: Math.min(99, Math.round((received / 211_200_000) * 100)) });
      }).then(() => out.end()).catch(reject);
    });
  } catch (e) {
    try { out.destroy(); } catch { /* ignore */ }
    removeDebDownload(stage);
    emit({ state: 'error', message: `Download failed: ${(e as Error).message}` });
    return;
  }
  const actual = hash.digest();
  const expected = Buffer.from(deb.sha512, 'base64');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(actual, expected)) {
    removeDebDownload(stage);
    emit({ state: 'error', message: 'Downloaded update failed its integrity check; not installing.' });
    return;
  }
  emit({ state: 'downloaded', version: deb.version });

  // Install with elevated privileges, fixing any dependencies, then relaunch.
  emit({ state: 'installing', version: deb.version });
  if (!await prepareInstall()) {
    removeDebDownload(stage);
    return;
  }
  installing = true;
  let finished = false;
  const fail = async (message: string): Promise<void> => {
    if (finished) return;
    finished = true;
    removeDebDownload(stage);
    await recoverFailedInstall(message);
  };
  let child;
  try {
    const command = privilegedDebInstallArgs(stage.path, deb.sha512);
    child = spawn(command.command, command.args, { stdio: 'ignore' });
  } catch (e) {
    await fail(`Couldn't launch the installer (${(e as Error).message}). Use "View release" to update manually.`);
    return;
  }
  child.on('error', (e) => {
    void fail(`Couldn't launch the installer (${e.message}). Use "View release" to update manually.`);
  });
  child.on('exit', (code) => {
    if (finished) return;
    if (code === 0) {
      finished = true;
      emit({ state: 'installed', version: deb.version });
      removeDebDownload(stage);
      setImmediate(() => { app.relaunch(); app.exit(0); });
    } else {
      // 126 = polkit auth dismissed/denied.
      const why = code === 126 ? 'cancelled at the password prompt' : `failed (exit ${code})`;
      void fail(`Update ${why}. You can try again or use "View release".`);
    }
  });
}

/** Open the latest-release page in the user's browser (notify path's CTA). */
export function openReleasePage(url?: string): void {
  void shell.openExternal(url || RELEASES_LATEST_PAGE);
}
