import './smoke-user-data';
import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import path from 'path';
import fs from 'fs';
import { Supervisor } from './supervisor';
import { config } from './config';
import { validateConfigSet } from './config';
import { getSecureBackend, isSecureBackendSafe, setSecret, getSecret, deleteSecret } from './secure-storage';
import { streamChat } from './llm-stream';
import { listModels, normalizeChatBaseUrl } from './llm-models';
import { detectHarnessLive } from './harness-detect';
import { coordinate, cancelCoordination, resetConversation, resumeSession, deletePersistedSession, oneShotChat } from './coordinator';
import { runLatencyTest } from './latency-test';
import { performance } from 'perf_hooks';
import { initTimers } from './timers';
import * as sessions from './sessions';
import { MAX_MEMORY_CHARS, MEMORY_KINDS, MemoryItem, MemoryKind } from './user-memory';
import { memoryStore } from './user-memory-app';
import { activeWindowBackend, selectionBackend } from './context-capture';
import * as sessionImport from './session-import';
import { buildManifest, missingOrInvalidModels, downloadModel } from './model-manager';
import { perfEnabled, setPerfEnabled, perfMark, perfMarkExternal } from './perf';
import { detectHardware, perfProfile, clampCap, resolveProfile, isPerfPreset, PerfPreset, ResourceProfile } from './hardware';
import {
  initUpdater, checkForUpdates, installUpdate, openReleasePage,
  currentVersion, deliveryChannel, isInstallingUpdate,
} from './updater';
import { IPC } from '../shared/ipc-channels';
import {
  SidecarName, isRendererSecretKey, isTrustedRendererUrl, validateLlmSendPayload,
} from '../shared/constants';
import { tunnel, installTunnelHook } from './tunnel-supervisor';
import { SttTurnGate, TranscribeRequest } from './stt-turn';
import { LlmGeneration, LlmGenerationGate, TtsAudioGate, TtsAudioPacket } from './voice-lifecycle';

// Chromium feature flags must be set in ONE enable-features switch — calling
// appendSwitch('enable-features', …) twice overwrites rather than merges.
//   - GlobalShortcutsPortal: global hotkeys via the xdg-desktop portal.
//   - WebRTCPipeWireCapturer: REQUIRED for getDisplayMedia()/desktopCapturer
//     screen capture on Wayland (the xdg-desktop-portal ScreenCast path).
//     Without it, screen share silently yields no usable source on Wayland —
//     the "screen share doesn't work" symptom.
const chromiumFeatures = ['GlobalShortcutsPortal'];
const isWayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');
if (isWayland) {
  chromiumFeatures.push('WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('ozone-platform-hint', 'wayland');
}
app.commandLine.appendSwitch('enable-features', chromiumFeatures.join(','));

// Linux secret storage: Chromium only auto-selects the Secret Service (GNOME
// Keyring / KeePassXC / KWallet's compat service) on GNOME/KDE-family desktops.
// On Hyprland, Sway, i3, etc. it silently falls back to "basic_text", which
// secure-storage.ts refuses to use — so no API key could ever be saved. Ask for
// libsecret explicitly; if no Secret Service is running Electron still reports
// an unsafe backend and the existing fail-closed path applies.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store')) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}
// NOTE: we intentionally keep vsync ENABLED. Disabling it (to chase uncapped
// FPS) made the orb tear/shake. The orb's rAF loop is FPS-capped per quality
// tier and its motion is time-based (see orb.js), so it looks identical at any
// display refresh.

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let supervisor: Supervisor;
let isQuitting = false;
// Renderer crash circuit breaker (see render-process-gone). Timestamps of recent
// crashes + a window during which HARDWARE_INFO reports a stepped-down GPU cap so
// the reloaded renderer starts conservative instead of re-crashing on the same
// config. Only ever engaged AFTER a real crash, so it never costs idle latency.
let renderCrashes: number[] = [];
let crashSafeUntil = 0;
let rendererUnresponsiveTimer: ReturnType<typeof setTimeout> | null = null;

function clearRendererUnresponsiveTimer(): void {
  if (!rendererUnresponsiveTimer) return;
  clearTimeout(rendererUnresponsiveTimer);
  rendererUnresponsiveTimer = null;
}

const SMOKE = process.env.ARIA_SMOKE === '1';
// smoke-ipc-hardening.js: record TTS_PLAY epoch acceptance instead of synthesizing.
const VERIFY_HARDENING = SMOKE && !!process.env.ARIA_VERIFY_HARDENING;
const smokeTtsPlays: { epoch: number; mainEpoch: number; accepted: boolean }[] = [];

// Global safety net: ARIA runs in the tray and must survive transient faults
// (a failed network call in the coordinator, a sidecar spawn that rejects, a
// stray async error) rather than crashing the whole app — the "it crashed while
// I was using it" symptom. Log loudly; don't exit. The sidecar supervisor still
// owns its own crash/restart handling; this only catches errors that escape it.
process.on('uncaughtException', (err) => {
  console.error('[ARIA] uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ARIA] unhandledRejection (kept alive):', reason);
});

// A GPU/utility child process crashing must not take ARIA down. Chromium
// recovers the GPU process and repaints the native orb video, so log it loudly
// and let the renderer continue.
app.on('child-process-gone', (_e, details) => {
  console.error(`[ARIA] child-process-gone: type=${details.type} reason=${details.reason}`);
});

// The only document ARIA's windows may ever display. Every IPC handler checks the
// sender frame against it (assertTrustedSender) and navigation away is refused.
const RENDERER_INDEX = path.join(__dirname, '..', 'renderer', 'index.html');

// Navigation/window hardening for EVERY webContents (current window, a crash-
// recovery replacement, devtools-spawned contents). The renderer is sandboxed,
// but a navigated or popped-up page would inherit the preload's `aria.*` bridge;
// refusing navigation, popups, and <webview> keeps that bridge on index.html.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, RENDERER_INDEX)) {
      event.preventDefault();
      console.warn('[ARIA] blocked navigation to', url);
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedRendererUrl(url, RENDERER_INDEX)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => { event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    console.warn('[ARIA] blocked window.open to', url);
    return { action: 'deny' };
  });
});

/**
 * True only for IPC from the top frame of ARIA's own window showing index.html.
 * Subframes, other webContents, and anything navigated elsewhere are refused.
 */
function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  return isTrustedRendererUrl(frame.url, RENDERER_INDEX);
}

function assertTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): void {
  if (!isTrustedSender(event)) {
    console.warn(`[ARIA] rejected IPC on ${channel} from untrusted sender ${event.senderFrame?.url ?? '(destroyed frame)'}`);
    throw new Error('Untrusted IPC sender');
  }
}

// Every renderer->main channel is registered through these wrappers so no
// handler can be added without the sender check.
type IpcArgs = any[];
function handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: IpcArgs) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event, channel);
    return fn(event, ...args);
  });
}
function on(channel: string, fn: (event: IpcMainEvent, ...args: IpcArgs) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    try { assertTrustedSender(event, channel); } catch { return; }
    fn(event, ...args);
  });
}

const isNonEmptyString = (v: unknown, max = 256): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    // Sized for the 3-column glass layout (sidebar + chat + ops rail); the
    // renderer collapses to 2/1 columns below 1080/720px CSS breakpoints.
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 540,
    show: !SMOKE, // headless boot test: don't pop a window on the user's desktop
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Hide the menu bar entirely (no File/Edit/View/Window). autoHideMenuBar stays
  // false + setMenuBarVisibility(false) so it can't be revealed with Alt either.
  // Editing accelerators are preserved by the app-level edit menu (see
  // applyAppMenu); this just removes the visible bar.
  win.autoHideMenuBar = false;
  win.setMenuBarVisibility(false);

  if (SMOKE) {
    // Surface renderer console + load failures to the main stdout so the
    // headless boot test can assert the renderer JS ran without throwing.
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[ARIA_SMOKE][renderer:${level}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log(`[ARIA_SMOKE][renderer] did-fail-load ${code} ${desc}`);
    });
  }

  // Closing the window HIDES it (keeps ARIA running in the background — wake word
  // stays active) instead of destroying it. The app only really quits from the
  // tray "Quit" (which sets isQuitting). Reopen via the tray, the global
  // shortcut, or relaunching the app (single-instance lock restores it).
  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });

  // Renderer crash recovery: if the renderer process dies (GPU/canvas fault, a
  // fatal JS error), reload the window instead of leaving a blank, dead app.
  // 'clean-exit' is a normal teardown (e.g. quit) and is left alone. Crucially we
  // reload into a STEPPED-DOWN GPU profile (see crashSafeUntil + HARDWARE_INFO) so
  // we don't reload straight back into the config that just crashed, and we bound
  // reload storms: 3+ crashes in 60s means a fast reload loop, so back off longer.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[ARIA] renderer gone:', details.reason);
    if (isQuitting || details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    renderCrashes = renderCrashes.filter((t) => now - t < 60000);
    renderCrashes.push(now);
    const storming = renderCrashes.length >= 3;
    crashSafeUntil = now + (storming ? 120000 : 30000); // run the orb safe for a while
    const delay = storming ? 3000 : 250; // don't hot-loop reloads
    setTimeout(() => { if (!isQuitting && !win.isDestroyed()) { try { win.reload(); } catch { /* nothing else */ } } }, delay);
  });

  // A hung renderer (Chromium fires this after ~30s of an unresponsive UI) is
  // recovered by reloading rather than leaving a frozen window — another path to
  // "it locked up while I was using it". Do not reload immediately, though:
  // response streaming/TTS can briefly trip Electron's unresponsive signal and an
  // instant reload is the user-visible "flash and reset when the agent responds"
  // bug. Give the renderer a grace window and cancel if Chromium reports it
  // responsive again.
  win.on('unresponsive', () => {
    console.error('[ARIA] renderer unresponsive — waiting before reload');
    if (rendererUnresponsiveTimer || isQuitting || win.isDestroyed()) return;
    rendererUnresponsiveTimer = setTimeout(() => {
      rendererUnresponsiveTimer = null;
      if (!isQuitting && !win.isDestroyed()) {
        console.error('[ARIA] renderer still unresponsive — reloading');
        try { win.reload(); } catch { /* nothing else to do */ }
      }
    }, 15000);
  });
  win.on('responsive', clearRendererUnresponsiveTimer);
  win.on('closed', clearRendererUnresponsiveTimer);

  win.loadFile(RENDERER_INDEX);
  return win;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) { mainWindow = createWindow(); return; }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

// Replace Electron's DEFAULT application menu (which shows File / Edit / View /
// Window) with an Edit-only menu. The visible bar is hidden per-window (see
// createWindow), so nothing shows on screen — but keeping the `editMenu` roles
// in the application menu preserves the standard editing accelerators
// (undo/redo/cut/copy/paste/selectAll) app-wide, so copy/paste still work in the
// chat box and on selected transcript text even with no visible menu.
function applyAppMenu(): void {
  const menu = Menu.buildFromTemplate([{ role: 'editMenu' }]);
  Menu.setApplicationMenu(menu);
}

function createTray(): void {
  // An empty image is invisible in the Windows tray and the macOS menu bar (where
  // the tray is a primary way to reach ARIA), so load the real icon there. Linux
  // keeps its existing behavior. icon.png is bundled via electron-builder `files`,
  // so the same ../../assets path resolves in dev and inside the asar.
  let icon = nativeImage.createEmpty();
  if (process.platform !== 'linux') {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
      if (!img.isEmpty()) {
        // macOS menu-bar icons want a small ~18px glyph; Windows scales the tray icon itself.
        icon = process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img;
      }
    } catch { /* fall back to the empty image */ }
  }
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show ARIA', click: () => showMainWindow() },
    { label: 'Start Listening', click: () => toggleListening() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('ARIA Voice Assistant');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => showMainWindow());
}

// Triggered by the global/in-window shortcut and the tray: bring ARIA forward and
// start a hands-free listen (same path as the wake word, VAD auto-endpointed).
function toggleListening(): void {
  showMainWindow();
  mainWindow?.webContents.send(IPC.WAKEWORD_DETECTED, 'shortcut');
}

function registerGlobalShortcut(): void {
  const shortcut = config.get('ui.globalShortcut') as string;
  let ok = false;
  try {
    // On Wayland register() often returns false (rather than throwing) when the
    // GlobalShortcuts portal is unavailable — check the boolean, don't assume.
    ok = globalShortcut.register(shortcut, toggleListening);
  } catch {
    ok = false;
  }
  if (!ok) {
    console.warn(
      `Global shortcut "${shortcut}" unavailable (Wayland portal). ` +
      'Falling back to tray toggle + in-window shortcut.',
    );
  }
  registerInWindowShortcut();
}

// Does a keyDown event match an Electron accelerator string (e.g.
// "Ctrl+Shift+A")? All modifiers must match exactly so a superset chord doesn't
// trigger it. ponytail: CmdOrCtrl is treated as Ctrl (ARIA's primary target is
// Linux); split per-platform if a Mac build needs Cmd here.
function matchesAccelerator(input: Electron.Input, accel: string): boolean {
  const parts = (accel || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const key = parts[parts.length - 1] || '';
  const has = (...names: string[]) => parts.some((p) => names.includes(p));
  return (
    input.control === has('ctrl', 'control', 'cmdorctrl', 'commandorcontrol') &&
    input.alt === has('alt', 'option') &&
    input.shift === has('shift') &&
    input.meta === has('super', 'meta', 'cmd', 'command') &&
    input.key.toLowerCase() === key
  );
}

// Focused fallback: when the window has focus, intercept the configured chord
// via before-input-event so the hotkey still works even if the global portal
// failed (common on Wayland). Reads ui.globalShortcut so it always matches
// whatever the global shortcut is set to.
function registerInWindowShortcut(): void {
  if (!mainWindow) return;
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    if (matchesAccelerator(input, config.get('ui.globalShortcut') as string)) {
      toggleListening();
    }
  });
}

function setupIpcHandlers(): void {
  // Memory panel. Every write is validated in MemoryStore (length, kind enum,
  // provenance); a locked/corrupt store surfaces as `error`, never overwritten.
  handle(IPC.MEMORY_LIST, () => {
    const store = memoryStore();
    let items: MemoryItem[] = [];
    try { items = store.list(); } catch { /* reported via error */ }
    return { items, encrypted: store.encrypted, error: store.error };
  });
  handle(IPC.MEMORY_ADD, (_e, text: unknown, kind: unknown) => {
    if (!isNonEmptyString(text, MAX_MEMORY_CHARS)) throw new Error('Invalid memory text');
    const k = typeof kind === 'string' && (MEMORY_KINDS as readonly string[]).includes(kind) ? kind as MemoryKind : undefined;
    return memoryStore().add(text, { source: 'edited', sourceText: 'Added in the Memory panel', kind: k });
  });
  handle(IPC.MEMORY_UPDATE, (_e, id: unknown, patch: unknown) => {
    if (!isNonEmptyString(id, 64) || !patch || typeof patch !== 'object') throw new Error('Invalid memory update');
    const p = patch as { text?: unknown; kind?: unknown };
    const updated = memoryStore().update(id, { text: p.text, kind: p.kind });
    if (!updated) throw new Error('Memory not found or invalid edit');
    return updated;
  });
  handle(IPC.MEMORY_DELETE, (_e, id: unknown) => {
    if (!isNonEmptyString(id, 64)) throw new Error('Invalid memory id');
    return memoryStore().remove(id);
  });
  handle(IPC.MEMORY_CLEAR, () => memoryStore().clear());
  handle(IPC.CONTEXT_STATUS, () => ({
    activeApp: activeWindowBackend(),
    selection: selectionBackend(),
    clipboard: process.platform === 'linux' && process.env.WAYLAND_DISPLAY ? 'wayland' : 'system',
  }));

  handle(IPC.SESSIONS_LIST, () => sessions.listSessions());
  handle(IPC.SESSIONS_GET, (_e, id: unknown) => (isNonEmptyString(id) ? sessions.getSession(id) : null));
  handle(IPC.SESSIONS_DELETE, (_e, id: unknown) => {
    if (!isNonEmptyString(id)) throw new Error('Invalid session id');
    return deletePersistedSession(id);
  });
  handle(IPC.SESSIONS_PIN, (_e, id: unknown, pinned: unknown) => {
    if (!isNonEmptyString(id) || typeof pinned !== 'boolean') throw new Error('Invalid session pin request');
    return sessions.setSessionPinned(id, pinned);
  });
  handle(IPC.SESSIONS_RESUME, (_e, id: unknown) => {
    if (!isNonEmptyString(id)) throw new Error('Invalid session id');
    return resumeSession(id);
  });
  handle(IPC.PERF_LATENCY_TEST, async () => {
    if (latencyTestRunning) return { ok: false, error: 'A test is already running.' };
    latencyTestRunning = true;
    const id = `${LATENCY_TEST_PREFIX}-${Date.now().toString(36)}`;
    try {
      return await runLatencyTest({
        synthesize: testSynthesize,
        transcribe: testTranscribe,
        chat: oneShotChat,
        now: () => performance.now(),
      }, id);
    } finally {
      latencyTestRunning = false;
      for (const [k, w] of sttWaiters) if (isLatencyTestId(k)) { sttWaiters.delete(k); w.reject(new Error('cancelled')); }
      for (const k of [...ttsCollectors.keys()]) if (isLatencyTestId(k)) ttsCollectors.delete(k);
    }
  });
  handle(IPC.SESSIONS_IMPORT_SOURCES, () => sessionImport.listSources());
  handle(IPC.SESSIONS_IMPORT_LIST, (_e, source: unknown) => {
    if (!sessionImport.isImportSource(source)) throw new Error('Unknown import source');
    const done = sessions.importedKeys();
    return sessionImport.listCandidates(source).map((c) => ({ ...c, imported: done.has(`${source}:${c.externalId}`) }));
  });
  handle(IPC.SESSIONS_IMPORT, (_e, source: unknown, ids: unknown) => {
    if (!sessionImport.isImportSource(source)) throw new Error('Unknown import source');
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every((v) => isNonEmptyString(v))) throw new Error('Invalid import selection');
    const convs = sessionImport.loadConversations(source, ids as string[]);
    const added = sessions.addImportedSessions(convs.map((c) => ({
      key: `${source}:${c.externalId}`, title: c.title, startedAt: c.startedAt, updatedAt: c.updatedAt, turns: c.turnList,
    })));
    return { requested: ids.length, found: convs.length, added };
  });

  handle(IPC.CONFIG_GET, (_e, key: unknown) => (isNonEmptyString(key) ? config.get(key) : undefined));
  handle(IPC.CONFIG_SET, (_e, rawKey: unknown, rawValue: unknown) => {
    // Renderer writes are limited to known leaf keys with type/enum/range-checked
    // values (config.ts). A rejection reaches the renderer as a rejected invoke.
    const key = typeof rawKey === 'string' ? rawKey : '';
    const checked = validateConfigSet(key, rawValue);
    if (!checked.ok) {
      console.warn(`[ARIA] CONFIG_SET rejected: ${checked.error}`);
      throw new Error(checked.error);
    }
    const value = checked.value;
    const changed = config.get(key) !== value;
    config.set(key, value);
    if (!changed) return;
    // Apply settings live so a change in the Settings panel takes effect without
    // restarting the app. Settings consumed per-request (llm.*/harness.*/
    // routing.mode, API keys) and the renderer-applied ones (ui.theme) are
    // already live; the ones below are only read by a sidecar at spawn, so the
    // sidecar's env is refreshed and it is restarted. All paths are debounced so
    // saving several related fields at once reloads each sidecar just once.
    if (key === 'wakeword.phrase' || key === 'wakeword.enabled') {
      scheduleWakewordReload();
    } else if (key === 'tts.voice' || key === 'tts.engine') {
      markCustomIfManaged(); scheduleSidecarReload('tts');
    } else if (key === 'tts.speed') {
      // Speaking rate applies live via a control message — no model reload. If the
      // sidecar isn't running yet, the refreshed ARIA_TTS_SPEED env covers its next
      // spawn.
      supervisor.sendToSidecar('tts', { type: 'set_speed', speed: Number(value) });
      process.env.ARIA_TTS_SPEED = String(Number(value));
    } else if (key === 'stt.model' || key === 'stt.backend') {
      markCustomIfManaged(); scheduleSidecarReload('stt');
    } else if (key === 'ui.gpuCap') {
      // The GPU cap changes STT's thread budget (and possibly its backend), which
      // the sidecar only reads at spawn — reload it so the new cap takes effect
      // live. The orb's quality is applied renderer-side (see app.js).
      markCustomIfManaged(); scheduleSidecarReload('stt');
    } else if (key === 'ui.perfPreset') {
      // Picking a resource preset writes a whole bundle of concrete settings
      // (STT model/backend, TTS engine/voice, GPU cap) and reloads the sidecars,
      // so the change is real + observable. 'custom' applies nothing.
      void applyResourcePreset(value as PerfPreset);
    } else if (key === 'remote.enabled' || key.startsWith('remote.')) {
      // Tunnel config changed. Sync the supervisor: it starts if the user just
      // enabled it and stops if they just disabled it. Host/port/identity edits
      // made while it's up take effect on the next Connect (Disconnect → edit →
      // Connect) — sync() deliberately doesn't restart a live tunnel per field
      // write, which would thrash it mid-edit.
      tunnel.sync();
    }
  });

  // Tunnel control (Settings → Remote access → Connect / Disconnect).
  // The tunnel state is also pushed to the renderer on every change
  // (the `tunnel.on('status', …)` hook above), so the renderer can
  // subscribe via TUNNEL_STATUS instead of polling.
  handle(IPC.TUNNEL_SNAPSHOT, () => tunnel.snapshot());
  on(IPC.TUNNEL_START, () => tunnel.start());
  on(IPC.TUNNEL_STOP, () => tunnel.stop());

  handle(IPC.SECURE_BACKEND, () => ({
    backend: getSecureBackend(),
    safe: isSecureBackendSafe(),
  }));
  // Only the two credentials the UI manages; other secure-store entries (if any)
  // are never reachable from the renderer.
  handle(IPC.SECURE_STORE_GET, (_e, key: unknown) => {
    if (!isRendererSecretKey(key)) throw new Error('Secure-store key not allowed');
    return getSecret(key);
  });
  handle(IPC.SECURE_STORE_SET, (_e, key: unknown, value: unknown) => {
    if (!isRendererSecretKey(key)) throw new Error('Secure-store key not allowed');
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid secret value');
    return setSecret(key, value);
  });
  handle(IPC.SECURE_STORE_DELETE, (_e, key: unknown) => {
    if (!isRendererSecretKey(key)) throw new Error('Secure-store key not allowed');
    return deleteSecret(key);
  });

  on(IPC.LLM_SEND, (_e, payload: unknown) => {
    // Shape/size validation (constants.ts): object payload, non-empty message
    // <= 32k chars, image null or a bounded data:image/jpeg;base64 URL, and a
    // non-empty turnId. Anything else is dropped before touching the gate.
    const { request, error: invalidReason, correlation } = validateLlmSendPayload(payload);
    if (!request) {
      console.warn(`[ARIA] LLM_SEND rejected: ${invalidReason}`);
      // Settle the renderer's pending turn (it already shows the user bubble
      // and 'processing') rather than leaving it hung with no error.
      if (correlation) {
        const rejected = llmGenerationGate.begin(correlation.turnId, correlation.generationId);
        cancelCoordination();
        if (llmGenerationGate.isCurrent(rejected)) {
          mainWindow?.webContents.send(IPC.LLM_ERROR, {
            error: invalidReason, turnId: rejected.turnId, generationId: rejected.generationId,
          });
        }
      }
      return;
    }
    const { message, image, turnId, generationId, files } = request;
    const generation = llmGenerationGate.begin(turnId, generationId);
    // Abort the prior stream before starting this generation. Its callbacks can
    // still arrive, so every callback below also checks the generation gate.
    cancelCoordination();
    perfMark(turnId, 'main_recv', image ? { image: 1 } : undefined);
    const isCurrent = () => llmGenerationGate.isCurrent(generation);
    const send = (channel: string, body: Record<string, unknown>) => {
      if (isCurrent()) mainWindow?.webContents.send(channel, { ...body, turnId: generation.turnId, generationId: generation.generationId });
    };
    coordinate(message, {
      onRoute: (info) => send(IPC.LLM_ROUTE, info),
      onContext: (used) => send(IPC.LLM_CONTEXT, { used }),
      onToken: (token) => send(IPC.LLM_TOKEN, { token }),
      onTool: (info) => send(IPC.LLM_TOOL, info),
      onDone: (text) => send(IPC.LLM_DONE, { text }),
      onError: (error) => send(IPC.LLM_ERROR, { error }),
    }, { image, files, turnId: generation.turnId, isCurrent }).catch((e: unknown) => {
      // A rejection escaping the coordinator must still settle this generation
      // in the renderer (otherwise the orb/turn stays pending forever).
      console.error('[ARIA] coordinate failed:', e);
      send(IPC.LLM_ERROR, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  // Latency instrumentation (see perf.ts): the renderer asks once whether marks
  // are enabled, then fire-and-forgets stage marks that we log in one timeline.
  handle(IPC.PERF_ENABLED, () => perfEnabled());
  on(IPC.PERF_MARK, (_e, m: { turn: string; stage: string; t?: number; extra?: Record<string, unknown> }) => {
    perfMarkExternal(m);
  });

  // Detected hardware + the adaptive profile for the current GPU cap, so the
  // Settings → Performance panel can show what ARIA detected and how it adapted.
  handle(IPC.HARDWARE_INFO, () => {
    const hw = detectHardware();
    let cap = clampCap(config.get('ui.gpuCap'));
    // Just crashed? Report a low cap for the cooldown so the reloaded renderer
    // brings the orb up at low quality/backing instead of the config that faulted.
    if (Date.now() < crashSafeUntil) cap = Math.min(cap, 35);
    return { hardware: hw, profile: perfProfile(hw, cap) };
  });

  // In-app updates (see updater.ts). The renderer asks for the current version +
  // delivery channel to render the Updates panel, triggers a check, and either
  // installs (AppImage) or opens the release page (.deb/dev).
  handle(IPC.UPDATE_CURRENT, () => ({ version: currentVersion(), channel: deliveryChannel() }));
  on(IPC.UPDATE_CHECK, () => { void checkForUpdates(); });
  on(IPC.UPDATE_INSTALL, () => { void installUpdate(); });
  on(IPC.UPDATE_OPEN, (_e, url?: string) => openReleasePage(url));

  // Barge-in: the renderer heard the wake word (or push-to-talk) while a reply
  // was still streaming — abort generation so ARIA stops talking and listens.
  on(IPC.LLM_CANCEL, (_e, raw?: unknown) => {
    const requested = raw && typeof raw === 'object' ? raw as Partial<LlmGeneration> : undefined;
    const generation = isNonEmptyString(requested?.turnId) && Number.isFinite(requested?.generationId)
      ? { turnId: requested!.turnId as string, generationId: Number(requested!.generationId) }
      : undefined;
    if (!generation || llmGenerationGate.isCurrent(generation)) {
      llmGenerationGate.cancel(generation);
      cancelCoordination();
    }
  });

  // New session: abort anything in flight and wipe the conversation history so
  // the next turn starts with no prior context.
  on(IPC.LLM_RESET, () => { llmGenerationGate.cancel(); cancelCoordination(); resetConversation(); });

  on(IPC.TTS_PLAY, (_e, request: { text?: string; replyId?: string; requestId?: string; epoch?: number }) => {
    const text = request?.text || '';
    const replyId = request?.replyId || '';
    const requestId = request?.requestId || '';
    const epoch = Number(request?.epoch);
    const accepted = !!text && !!replyId && !!requestId && Number.isFinite(epoch) && epoch === ttsEpoch;
    if (VERIFY_HARDENING) { smokeTtsPlays.push({ epoch, mainEpoch: ttsEpoch, accepted }); return; }
    if (!accepted) return;
    ttsAudioGate.activate(replyId, epoch);
    queueTtsControl(epoch, async () => {
      supervisor.sendToSidecar('tts', { type: 'synthesize', text, reply_id: replyId, request_id: requestId, epoch });
    });
  });

  on(IPC.TTS_REPLY_DONE, (_e, request: { replyId?: string; epoch?: number }) => {
    const replyId = request?.replyId || '';
    const epoch = Number(request?.epoch);
    if (!replyId || !Number.isFinite(epoch) || epoch !== ttsEpoch) return;
    ttsAudioGate.activate(replyId, epoch);
    queueTtsControl(epoch, async () => {
      supervisor.sendToSidecar('tts', { type: 'reply_done', reply_id: replyId, epoch });
    });
  });

  // Main owns the TTS epoch; it survives renderer reloads (crash recovery,
  // unresponsive reload). The renderer seeds from TTS_EPOCH at startup and
  // adopts the value TTS_STOP resolves, so a reloaded renderer (which restarts at
  // 0) can never be stuck below main's epoch with every chunk dropped.
  handle(IPC.TTS_EPOCH, () => ttsEpoch);
  handle(IPC.SIDECAR_SNAPSHOT, () => ({ ...lastSidecarLifecycle }));
  handle(IPC.TTS_STOP, (_e, request?: { epoch?: unknown }) => {
    const requestedEpoch = Number(request?.epoch);
    // Accept a renderer-proposed epoch only if it moves forward by a sane step.
    const nextEpoch = Number.isSafeInteger(requestedEpoch) && requestedEpoch > ttsEpoch
      && requestedEpoch <= ttsEpoch + 1_000_000
      ? requestedEpoch : ttsEpoch + 1;
    ttsEpoch = nextEpoch;
    ttsAudioGate.activate('', ttsEpoch);
    supervisor.sendToSidecar('tts', { type: 'stop', epoch: ttsEpoch });
    return ttsEpoch;
  });

  // Onboarding "Test connection": one short non-streaming round-trip to confirm
  // the endpoint + key work. Returns {ok} or {ok:false, error}.
  handle(IPC.LLM_TEST, async (_e, opts: { endpoint: string; model: string; apiKey?: string }) => {
    return await new Promise((resolve) => {
      let settled = false;
      const done = (r: { ok: boolean; error?: string }) => { if (!settled) { settled = true; resolve(r); } };
      streamChat(
        { endpoint: opts.endpoint, model: opts.model, apiKey: opts.apiKey, message: 'Say "ok".', timeoutMs: 12000 },
        {
          onToken: () => { /* first token is enough to prove it works */ done({ ok: true }); },
          onDone: () => done({ ok: true }),
          onError: (error) => done({ ok: false, error }),
        },
      );
    });
  });

  // Model auto-discovery for an OpenAI-compatible endpoint (Hermes, Ollama, LM
  // Studio, vLLM…). Asks for GET /v1/models, parses the OpenAI `data[].id` list,
  // and returns the recommended default + the full list so the UI can show a
  // dropdown. Used by the Settings → Agent-harness / Conversational-LLM "Discover
  // model" buttons; never persists anything by itself. The endpoint URL accepts
  // the same shape as chat (full chat-completions URL, .../v1 base, or host only)
  // — normalizeChatBaseUrl() converts it to the /v1/models route. A missing or
  // unauthorized endpoint returns ok:false with the underlying error so the UI
  // can show "discovery failed — enter the model manually".
  handle(IPC.LLM_LIST_MODELS, async (_e, opts: { endpoint: string; apiKey?: string }) => {
    return await listModels(opts.endpoint, opts.apiKey || '');
  });

  // Auto-detect a local harness's connection from the config it wrote on disk
  // (Hermes → ~/.hermes/.env, etc.). Reads the endpoint + gateway key so the
  // Settings/onboarding fields can pre-fill without the user hunting for the
  // key. Read-only; never persists — the renderer saves via the normal path.
  handle(IPC.LLM_DETECT_HARNESS, (_e, id: string) => detectHarnessLive(typeof id === 'string' ? id : ''));

  // Mic PCM from the renderer (getUserMedia, 16kHz mono s16le). Always feed the
  // always-on wake-word sidecar; also feed STT while an utterance is active.
  on(IPC.MIC_AUDIO, (_e, chunk: unknown) => {
    // 16 kHz s16le frames are a few KB; refuse anything that isn't a bounded buffer.
    if (!(chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk))) return;
    if (chunk.byteLength === 0 || chunk.byteLength > 256 * 1024) return;
    const buf = chunk instanceof ArrayBuffer
      ? Buffer.from(chunk)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (config.get('wakeword.enabled')) supervisor.sendPcm('wakeword', buf);
    const readyChunk = sttGate.pushAudio(buf);
    if (readyChunk) supervisor.sendPcm('stt', readyChunk);
  });

  on(IPC.STT_START, (_e, turnId?: unknown) => {
    const requestedTurnId = isNonEmptyString(turnId, 128) ? turnId : `voice-${Date.now()}`;
    sttActiveTurn = null;
    sttTurnId = requestedTurnId;
    sttGate.begin(requestedTurnId);
    perfMark(requestedTurnId, 'stt_start');
    void (async () => {
      try {
        await ensureSidecar('stt', STT_START_DEADLINE_MS);
        // A newer utterance may supersede this async startup. Never let an old
        // promise reset the new turn's buffered audio.
        if (sttGate.isCurrent(requestedTurnId)) {
          if (supervisor.sendToSidecar('stt', { type: 'start', utterance_id: requestedTurnId })) {
            sttActiveTurn = requestedTurnId; // sidecar now owns this turn's state
          }
        }
      } catch (e) {
        if (sttGate.failStart(requestedTurnId)) {
          mainWindow?.webContents.send(IPC.STT_STATE, { state: 'stt_failed', turnId: requestedTurnId, error: (e as Error).message });
        }
        console.error('[ARIA] STT start failed:', (e as Error).message);
      }
    })();
  });

  on(IPC.STT_SPECULATE, (_e, turnId?: unknown) => {
    if (!isNonEmptyString(turnId, 128) || config.get('stt.speculative') === false) return;
    const request = sttGate.speculate(turnId);
    if (!request) return;
    perfMark(turnId, 'stt_speculate_req', { bytes: request.audioBytes });
    supervisor.sendToSidecar('stt', { type: 'speculate', utterance_id: request.turnId, audio_bytes: request.audioBytes });
  });

  on(IPC.STT_END, (_e, turnId?: unknown) => {
    if (typeof turnId !== 'string') return;
    if (turnId && !sttGate.isCurrent(turnId)) return;
    perfMark(sttTurnId, 'stt_transcribe_req');
    const request = sttGate.end();
    if (request) sendSttTranscribe(request);
  });
}

const sttGate = new SttTurnGate();
const llmGenerationGate = new LlmGenerationGate();
const ttsAudioGate = new TtsAudioGate();
let ttsEpoch = 0;
let ttsControlChain: Promise<void> = Promise.resolve();
const STT_START_DEADLINE_MS = 5000;
// Turn id of the in-flight voice utterance (from the renderer), so the STT
// stage marks join the same timeline as that turn's later LLM/TTS marks.
let sttTurnId = '';
// The STT turn the sidecar process itself holds state for: set once `start` was
// delivered to it (and again on ack/transcribe), cleared on result/failure. If
// the process dies meanwhile, that turn's result can never arrive.
let sttActiveTurn: string | null = null;
const STT_DEATH_STATUSES = new Set(['exited', 'heartbeat-timeout', 'memory-exceeded', 'circuit-open', 'error']);

/** Fail the in-flight STT turn when the sidecar holding it died. */
function failSttTurnOnSidecarDeath(status: string, detail?: string): void {
  const turnId = sttActiveTurn;
  if (!turnId || !STT_DEATH_STATUSES.has(status)) return;
  sttActiveTurn = null;
  if (!sttGate.failStart(turnId)) return;
  mainWindow?.webContents.send(IPC.STT_STATE, {
    state: 'stt_failed', turnId, error: `Speech recognition stopped (${status}${detail ? `: ${detail}` : ''})`,
  });
}

function queueTtsControl(epoch: number, action: () => Promise<void>): void {
  ttsControlChain = ttsControlChain.catch(() => {}).then(async () => {
    if (epoch !== ttsEpoch) return;
    await ensureSidecar('tts');
    if (epoch === ttsEpoch) await action();
  }).catch((e) => console.error('[ARIA] TTS control failed:', (e as Error).message));
}

// ---- Latency test plumbing -------------------------------------------------
// Test audio/transcripts are tagged with a 'latency-test' id and diverted here,
// so nothing reaches the speakers, the transcript or the conversation.
const LATENCY_TEST_PREFIX = 'latency-test';
const isLatencyTestId = (id: unknown) => typeof id === 'string' && id.startsWith(LATENCY_TEST_PREFIX);
interface TtsCollector { chunks: Buffer[]; sampleRate: number; requestedAt: number; firstChunkAt: number; done: () => void; fail: (e: Error) => void; }
const ttsCollectors = new Map<string, TtsCollector>();
const sttWaiters = new Map<string, { resolve: (text: string) => void; reject: (e: Error) => void; onSent: (t: number) => void }>();
let latencyTestRunning = false;

function failLatencyTest(name: SidecarName, status: string): void {
  const err = new Error(`${name === 'tts' ? 'The voice' : name === 'stt' ? 'Speech recognition' : name} stopped during the test (${status}).`);
  if (name === 'tts') for (const c of [...ttsCollectors.values()]) c.fail(err);
  if (name === 'stt') for (const [k, w] of [...sttWaiters]) { sttWaiters.delete(k); w.reject(err); }
}

function testSynthesize(text: string, replyId: string) {
  return new Promise<{ chunks: Buffer[]; sampleRate: number; firstChunkAt: number; requestedAt: number }>((resolveP, rejectP) => {
    void ensureSidecar('tts').then(() => {
      const c: TtsCollector = { chunks: [], sampleRate: 24000, requestedAt: 0, firstChunkAt: 0, done: () => {},
        fail: (e) => { ttsCollectors.delete(replyId); rejectP(e); } };
      c.done = () => {
        ttsCollectors.delete(replyId);
        if (!c.chunks.length) { rejectP(new Error('The voice produced no audio.')); return; }
        resolveP({ chunks: c.chunks, sampleRate: c.sampleRate, firstChunkAt: c.firstChunkAt, requestedAt: c.requestedAt });
      };
      ttsCollectors.set(replyId, c);
      ttsAudioGate.activate(replyId, ttsEpoch);
      c.requestedAt = performance.now();
      supervisor.sendToSidecar('tts', { type: 'synthesize', text, reply_id: replyId, request_id: `${replyId}:1`, epoch: ttsEpoch });
      supervisor.sendToSidecar('tts', { type: 'reply_done', reply_id: replyId, epoch: ttsEpoch });
    }, rejectP);
  });
}

function testTranscribe(pcm: Buffer, turnId: string, onSent: (t: number) => void) {
  return new Promise<string>((resolveP, rejectP) => {
    void ensureSidecar('stt', STT_START_DEADLINE_MS).then(() => {
      sttWaiters.set(turnId, { resolve: resolveP, reject: rejectP, onSent });
      // Synchronous: no live-mic IPC can interleave between begin and end, so
      // only the test audio is captured for this turn.
      sttActiveTurn = null;
      sttTurnId = turnId;
      sttGate.begin(turnId);
      const FRAME = 3200; // 100 ms at 16 kHz s16le, like real mic frames
      for (let i = 0; i < pcm.length; i += FRAME) sttGate.pushAudio(pcm.subarray(i, i + FRAME));
      sttGate.end();
      if (supervisor.sendToSidecar('stt', { type: 'start', utterance_id: turnId })) sttActiveTurn = turnId;
    }, rejectP);
  });
}

function deliverTtsPackets(packets: TtsAudioPacket[]): void {
  const forRenderer: TtsAudioPacket[] = [];
  for (const packet of packets) {
    const col = ttsCollectors.get(packet.replyId);
    if (col) {
      if (!col.chunks.length) col.firstChunkAt = performance.now();
      col.sampleRate = packet.sampleRate || col.sampleRate;
      col.chunks.push(Buffer.from(packet.pcm));
    } else forRenderer.push(packet);
  }
  packets = forRenderer;
  for (const packet of packets) {
    mainWindow?.webContents.send(IPC.TTS_AUDIO, {
      pcm: packet.pcm,
      replyId: packet.replyId,
      requestId: packet.requestId,
      epoch: packet.epoch,
      sampleRate: packet.sampleRate,
    });
  }
  for (const done of ttsAudioGate.takeReplyDone()) {
    const col = ttsCollectors.get(done.replyId);
    if (col) { col.done(); continue; }
    mainWindow?.webContents.send(IPC.TTS_STATE, { state: 'reply_done', replyId: done.replyId, epoch: done.epoch });
  }
}

const lastSidecarLifecycle: Record<string, string> = {};
const LIFECYCLE_STATUSES = new Set(['ready', 'started', 'initialized', 'restarting', 'circuit-reset', 'error', 'circuit-open', 'exited', 'memory-exceeded', 'heartbeat-timeout']);

function onSidecarStatus(name: SidecarName, status: string, detail?: string): void {
  if (LIFECYCLE_STATUSES.has(status)) lastSidecarLifecycle[name] = status;
  if (name === 'tts' && (status === 'started' || status === 'exited')) ttsAudioGate.resetTransport();
  if (STT_DEATH_STATUSES.has(status)) failLatencyTest(name, status);
  if (name === 'stt') failSttTurnOnSidecarDeath(status, detail);
  mainWindow?.webContents.send(IPC.SIDECAR_STATUS, { name, status, detail });
  if (status === 'error' || status === 'circuit-open') {
    mainWindow?.webContents.send(IPC.SIDECAR_ERROR, { name, status, detail });
  }
  if (SMOKE) console.log(`[ARIA_SMOKE][${name}] ${status}${detail ? ': ' + detail : ''}`);
}

function sendSttTranscribe(request: TranscribeRequest): void {
  sttActiveTurn = request.turnId;
  sttWaiters.get(request.turnId)?.onSent(performance.now());
  supervisor.sendToSidecar('stt', {
    type: 'transcribe',
    utterance_id: request.turnId,
    audio_bytes: request.audioBytes,
  });
}

app.whenReady().then(async () => {
  // Measurement hook: with ARIA_VERIFY_CLASSIFIER=1 the app runs the turn
  // classifier against the unclassifiable utterances using the configured chat
  // model, prints the report, and quits. See src/main/classifier-check.ts.
  if (process.env.ARIA_VERIFY_CLASSIFIER === '1') {
    try {
      const { runClassifierCheck } = await import('./classifier-check');
      await runClassifierCheck();
    } catch (e) {
      console.log('[classifier-check] failed:', e instanceof Error ? e.message : String(e));
    }
    app.exit(0);
    return;
  }

  // Wire the SSH tunnel supervisor to the renderer BEFORE we instantiate
  // the sidecar supervisor, so the tunnel status (connected / error)
  // can flow to the UI as soon as it's up. The tunnel supervisor is
  // lazy — nothing is spawned until the user enables it in Settings.
  installTunnelHook();
  tunnel.on('status', (s) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.TUNNEL_STATUS, s);
    }
  });
  // Sync once on startup (if `remote.enabled` was persisted from a
  // previous run, bring the tunnel back up automatically).
  tunnel.sync();

  // Re-arm persisted timers/alarms/reminders (see timers.ts). Firing pushes an
  // announcement to the renderer, which shows it in the transcript and speaks
  // it — this works with the window hidden in the tray.
  initTimers((text) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.TIMER_FIRED, text);
    }
  });

  supervisor = new Supervisor(
    onSidecarStatus,
    (name: SidecarName, msg: Record<string, unknown>) => {
      routeSidecarMessage(name, msg);
    },
  );

  supervisor.onBinaryData((name: SidecarName, data: Buffer) => {
    // TTS PCM has no packet boundaries. Frame it with the corresponding stdout
    // byte announcements before crossing Electron IPC so metadata and bytes
    // cannot be paired with another request after a stop/new-play race.
    if (name === 'tts') {
      deliverTtsPackets(ttsAudioGate.push(data));
    }
  });

  // Latency instrumentation: honor either the env var (already read in perf.ts)
  // or the persisted config flag, so it can be turned on without an env change.
  if (config.get('debug.perf') === true) setPerfEnabled(true);
  if (perfEnabled()) console.log('[ARIA_PERF] instrumentation ENABLED');

  setupIpcHandlers();

  // Screen share: auto-grant the primary display when the renderer calls
  // getDisplayMedia() so there is no OS picker — ARIA shares the whole screen
  // with the agent on demand (toggled by the user via button or voice command).
  try {
    const { session, desktopCapturer } = require('electron');
    session.defaultSession.setDisplayMediaRequestHandler((_request: unknown, callback: (arg: unknown) => void) => {
      // Don't restrict by `types` to a single value on every OS: Windows enumerates
      // displays as 'screen' sources, same as Linux/macOS, but if none come back we
      // must know WHY (a permission/enumeration failure is the likely "screen share
      // doesn't work on Windows" cause) instead of silently handing back undefined.
      desktopCapturer.getSources({ types: ['screen'] }).then((sources: { id: string; name: string }[]) => {
        if (!sources.length) {
          console.error('[ARIA] screen share: desktopCapturer returned no screen sources (check OS screen-recording permission).');
          callback(undefined);
          return;
        }
        callback({ video: sources[0] });
      }).catch((err: unknown) => {
        console.error('[ARIA] screen share: getSources failed:', (err as Error).message);
        callback(undefined);
      });
    }, { useSystemPicker: false });
  } catch (e) {
    console.error('[ARIA] display-media handler setup failed:', (e as Error).message);
  }

  // Remove the default File/Edit/View/Window menu (keep editing accelerators).
  applyAppMenu();

  mainWindow = createWindow();
  try {
    createTray();
  } catch (err) {
    console.error('Tray unavailable:', (err as Error).message);
  }
  registerGlobalShortcut();

  // Update installation quiesces only live sidecars. If polkit/the installer is
  // cancelled, that exact snapshot is resumed instead of leaving voice disabled.
  if (!SMOKE) {
    let updateSidecars: SidecarName[] = [];
    initUpdater(mainWindow, {
      beforeInstall: async () => { updateSidecars = await supervisor.quiesceForUpdate(); },
      afterInstallFailure: async () => {
        await supervisor.resumeAfterUpdate(updateSidecars);
        updateSidecars = [];
      },
    });
    setTimeout(() => { void checkForUpdates(); }, 8000);
  }

  supervisor.startMonitoring();

  // Make the active resource preset real before anything reads its values: the
  // default 'auto' preset adapts gpuCap (and the STT/TTS bundle) to the detected
  // hardware, which is what lifts the orb to high quality on a capable GPU.
  applyStartupPreset();

  // Push config-derived settings into the environment the sidecars inherit
  // (model choice, STT backend, TTS voice, wake-word phrase/threshold).
  applyConfigToEnv();

  // First-run: ensure STT/TTS model weights are present before starting
  // sidecars. Downloads are resumable + checksummed; progress goes to the UI.
  const modelsOk = await ensureModelsReady();

  // Always-on wake-word listener. Its models ship bundled, so it must NOT be
  // gated on STT/TTS model downloads — a missing/mismatched TTS voice file used
  // to make modelsOk false and silently disable the wake word entirely.
  if (config.get('wakeword.enabled')) {
    try { await supervisor.start('wakeword'); }
    catch (e) { console.error('[ARIA] wakeword start failed:', (e as Error).message); }
  }

  // Pre-warm STT shortly after startup (unless disabled) so the first wake word
  // doesn't pay the whisper model-load cost mid-utterance — the main source of
  // the "laggy until STT finishes" hitch. Done in the background so it doesn't
  // block startup. TTS stays lazy (loaded when first needed).
  if (modelsOk && !SMOKE && config.get('stt.prewarm') !== false) {
    setTimeout(() => { void ensureSidecar('stt').catch((e) => console.error('[ARIA] STT prewarm failed:', (e as Error).message)); }, 2500);
  }

  // Pre-warm TTS too (staggered after STT to avoid a load spike), so the first
  // reply doesn't pay the model-load + ONNX cold-start cost mid-conversation —
  // the dominant chunk of the text->audio delay. The sidecar runs a throwaway
  // synthesis on load, so by 'ready' the graph is hot.
  if (modelsOk && !SMOKE && config.get('tts.prewarm') !== false) {
    setTimeout(() => { void ensureSidecar('tts').catch((e) => console.error('[ARIA] TTS prewarm failed:', (e as Error).message)); }, 3500);
  }

  if (SMOKE) {
    // Headless boot test: confirm the app initialized, then quit cleanly.
    console.log('[ARIA_SMOKE] app ready, window+tray+supervisor initialized');

    // Menu verification (Item 4): report the application menu's top-level labels,
    // the editing roles it still carries, and whether the window's menu bar is
    // visible. Consumed by scripts/smoke-menu.js.
    if (process.env.ARIA_VERIFY_MENU) {
      const m = Menu.getApplicationMenu();
      const labels = m ? m.items.map((i) => i.label || i.role || '') : [];
      const roles: string[] = [];
      if (m) for (const it of m.items) {
        const sub = it.submenu;
        if (sub) for (const s of sub.items) if (s.role) roles.push(s.role);
      }
      console.log('[ARIA_VERIFY] appmenu-toplevel=' + JSON.stringify(labels));
      console.log('[ARIA_VERIFY] appmenu-roles=' + JSON.stringify(roles));
      console.log('[ARIA_VERIFY] menubar-visible=' + (mainWindow ? mainWindow.isMenuBarVisible() : 'n/a'));
    }

    // Live latency baseline: when ARIA_PERF_LIVE points at a (mock) endpoint,
    // drive ONE real text turn through the genuine UI path (text box -> Enter ->
    // submitUserMessage -> IPC -> coordinate -> streamChat) so the full
    // cross-process [ARIA_PERF] timeline is emitted. Used by scripts/perf-live.js.
    if (process.env.ARIA_PERF_LIVE && mainWindow) {
      config.set('llm.endpoint', process.env.ARIA_PERF_LIVE);
      config.set('routing.mode', 'llm');
      setTimeout(() => {
        mainWindow?.webContents.executeJavaScript(
          `(function(){var ti=document.getElementById('text-input');` +
          `document.querySelectorAll('.overlay,#onboard-overlay,#settings-overlay').forEach(function(e){e.classList.remove('visible');});` +
          `ti.value=${JSON.stringify(process.env.ARIA_PERF_LIVE_MSG || 'what time is it')};` +
          `ti.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})(); true;`,
        ).catch(() => {});
      }, 1200);
    }

    // Performance-panel verification: fire a turn's worth of perf marks into the
    // REAL renderer, open Settings, and read back the per-stage latency rows +
    // the detected-hardware line — so the panel's end-to-end DOM wiring (not just
    // perf.js's math) is exercised headlessly. Consumed by scripts/smoke-perf-panel.js.
    if (process.env.ARIA_VERIFY_PERF && mainWindow) {
      const wc = mainWindow.webContents;
      (async () => {
        try {
          const out = await wc.executeJavaScript(`(async function(){
            var P = window.AriaPerf;
            var t = P.newTurn('text');
            P.mark(t,'user_input'); P.mark(t,'dispatch');
            await new Promise(function(r){setTimeout(r,60);});
            P.mark(t,'first_token_render'); P.mark(t,'tts_first_request');
            await new Promise(function(r){setTimeout(r,40);});
            P.mark(t,'tts_first_audio'); P.mark(t,'turn_complete');
            P.setTurnMeta(t,{target:'LLM'});
            // Dismiss the first-run onboarding overlay, then open Settings (which
            // runs loadSettings -> refreshPerfPanel + renderHardware).
            var ob = document.getElementById('onboard-overlay'); if (ob) ob.classList.remove('visible');
            document.getElementById('settings-btn').click();
            await new Promise(function(r){setTimeout(r,500);});
            var snap = {
              firstAudio: document.getElementById('perf-first-audio').textContent,
              stt: document.getElementById('perf-stt').textContent,
              llm: document.getElementById('perf-llm').textContent,
              llmLabel: document.getElementById('perf-llm-label').textContent,
              tts: document.getElementById('perf-tts').textContent,
              hw: document.getElementById('perf-hw').textContent,
              perfPreset: document.getElementById('cfg-perf-preset').value,
              updVersion: document.getElementById('update-version').textContent,
              updHint: document.getElementById('update-channel-hint').textContent
            };
            // Prove a preset REALLY changes settings: pick power-saver and read back
            // the STT model + voice dropdowns (config writes happen even in SMOKE;
            // only the sidecar reload is skipped).
            var pp = document.getElementById('cfg-perf-preset');
            pp.value = 'power-saver'; pp.dispatchEvent(new Event('change'));
            await new Promise(function(r){setTimeout(r,500);});
            snap.psSttModel = document.getElementById('cfg-stt-model').value;
            snap.psTtsVoice = document.getElementById('cfg-tts-voice').value;
            snap.psPreset = document.getElementById('cfg-perf-preset').value;
            // Manually changing the STT model must flip the preset to Custom.
            var sm = document.getElementById('cfg-stt-model');
            sm.value = 'small';
            await window.aria.config.set('stt.model','small');
            snap.customPreset = await window.aria.config.get('ui.perfPreset');
            // Voice-turn latency check: "time to first audio" and "full reply"
            // must be timed from the END of speech (audio_end), not its start —
            // the seconds spent speaking are the user's, not the system's latency.
            // Simulate a 200ms utterance with a ~100ms post-speech path; a correct
            // panel reports ~100ms, the old audio_start bug reported ~300ms.
            var vt = P.newTurn('voice');
            P.mark(vt,'audio_start');
            await new Promise(function(r){setTimeout(r,200);}); // speaking
            P.mark(vt,'audio_end');
            await new Promise(function(r){setTimeout(r,30);});
            P.mark(vt,'stt_result_render'); P.mark(vt,'user_input'); P.mark(vt,'dispatch');
            await new Promise(function(r){setTimeout(r,40);});
            P.mark(vt,'first_token_render'); P.mark(vt,'tts_first_request');
            await new Promise(function(r){setTimeout(r,30);});
            P.mark(vt,'tts_first_audio'); P.mark(vt,'turn_complete');
            var vs = P.lastStages();
            snap.voiceFirstAudio = vs ? vs.firstAudio : null;
            snap.voiceTotal = vs ? vs.total : null;
            return JSON.stringify(snap);
          })()`);
          console.log('[ARIA_VERIFY] perf-panel=' + out);
        } catch (e) {
          console.log('[ARIA_VERIFY] perf error:', (e as Error).message);
        }
        setTimeout(() => { void supervisor.stopAll().then(() => app.exit(0)); }, 1000);
      })();
      return; // skip the standard auto-quit while verifying
    }

    // Live-settings verification (Item 1): start TTS, then change tts.voice
    // through the REAL config IPC path and let the sidecar reload pick it up.
    // The external verifier (scripts/smoke-settings-live.js) watches for a SECOND
    // 'initialized' status carrying the new voice. Uses an isolated --user-data-dir
    // so it never clobbers the user's config.
    if (process.env.ARIA_VERIFY_SETTINGS && mainWindow) {
      (async () => {
        try {
          console.log('[ARIA_VERIFY] starting tts sidecar (initial voice from config)…');
          await ensureSidecar('tts');
          const newVoice = process.env.ARIA_VERIFY_VOICE || 'af_sarah';
          console.log(`[ARIA_VERIFY] tts ready; setting tts.voice=${newVoice} via config IPC`);
          await mainWindow!.webContents.executeJavaScript(
            `aria.config.set('tts.voice', ${JSON.stringify(newVoice)}); true;`,
          );
        } catch (e) {
          console.log('[ARIA_VERIFY] error:', (e as Error).message);
        }
      })();
      // Safety net: quit if the external verifier didn't kill us first.
      setTimeout(() => { void supervisor.stopAll().then(() => app.exit(0)); }, 20000);
      return; // skip the standard 4s auto-quit while verifying
    }

    // IPC/navigation hardening + TTS epoch reload verification. Drives the REAL
    // renderer: bumps main's TTS epoch via stops, reloads the renderer (as crash
    // recovery does), and confirms the fresh renderer seeded main's epoch; then
    // attempts navigation / window.open / a disallowed secure key / an invalid
    // config write. Consumed by scripts/smoke-ipc-hardening.js.
    if (process.env.ARIA_VERIFY_HARDENING && mainWindow) {
      const wc = mainWindow.webContents;
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const out: Record<string, unknown> = {};
      (async () => {
        try {
          await delay(800);
          await wc.executeJavaScript(`(async()=>{for(let i=0;i<3;i++) await aria.tts.stop({}); return true;})()`);
          out.mainEpochBeforeReload = ttsEpoch;
          const reloaded = new Promise<void>((r) => wc.once('did-finish-load', () => r()));
          wc.reload();
          await reloaded;
          await delay(600);
          out.mainEpochAfterReload = ttsEpoch;
          // A timer announcement runs the real speakOnly -> stopPlayback(true) ->
          // ttsPlay path; main records whether the play's epoch matched its own.
          wc.send(IPC.TIMER_FIRED, 'hardening check one');
          await delay(400);
          wc.send(IPC.TIMER_FIRED, 'hardening check two');
          await delay(400);
          out.ttsPlays = smokeTtsPlays.slice();
          // STT sidecar death with a turn in flight must fail that turn; a
          // benign status (log) must not.
          sttGate.begin('verify-stt-a'); sttActiveTurn = 'verify-stt-a';
          onSidecarStatus('stt', 'log', 'noise');
          out.sttSurvivesLog = sttGate.isCurrent('verify-stt-a');
          onSidecarStatus('stt', 'heartbeat-timeout', 'verify');
          out.sttFailedOnDeath = !sttGate.isCurrent('verify-stt-a') && sttActiveTurn === null;
          out.windowOpen = await wc.executeJavaScript(`String(window.open('https://example.com/'))`);
          await wc.executeJavaScript(`location.href='https://example.com/'; true`).catch(() => {});
          await delay(400);
          out.urlAfterNavigate = wc.getURL();
          out.secureBadKey = await wc.executeJavaScript(`aria.secure.get('not-a-key').then(()=> 'allowed', ()=> 'rejected')`);
          out.secureGoodKey = await wc.executeJavaScript(`aria.secure.get('llm-api-key').then(()=> 'allowed', ()=> 'rejected')`);
          out.configBad = await wc.executeJavaScript(`aria.config.set('tts.speed','fast').then(()=> 'allowed', ()=> 'rejected')`);
          out.configGood = await wc.executeJavaScript(`aria.config.set('audio.volume',0.5).then(()=> 'allowed', ()=> 'rejected')`);
          // The routing coordinator is a two-value enum the renderer writes; a
          // typo must be refused rather than silently stored and ignored.
          out.coordinatorBad = await wc.executeJavaScript(`aria.config.set('routing.coordinator','jev-typo').then(()=> 'allowed', ()=> 'rejected')`);
          out.coordinatorGood = await wc.executeJavaScript(`aria.config.set('routing.coordinator','jev').then(()=> 'allowed', ()=> 'rejected')`);
        } catch (e) {
          out.error = (e as Error).message;
        }
        console.log('[ARIA_VERIFY] hardening=' + JSON.stringify(out));
        await supervisor.stopAll();
        app.exit(0);
      })();
      return;
    }

    // Screen-share chat-state verification (Item 7): fake getDisplayMedia with a
    // canvas-backed stream (no portal), build a 3+ message conversation, toggle
    // screen share, and dump the conversation before/after to catch a duplicated
    // first message. Used by scripts/smoke-screenshare.js.
    if (process.env.ARIA_VERIFY_SCREENSHARE && mainWindow) {
      const wc = mainWindow.webContents;
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      if (process.env.ARIA_VERIFY_LLM_ENDPOINT) {
        config.set('llm.endpoint', process.env.ARIA_VERIFY_LLM_ENDPOINT);
        config.set('routing.mode', 'llm');
      }
      const snap = `(function(){return JSON.stringify(Array.from(document.querySelectorAll('#conversation .message')).map(function(m){return {role:m.classList.contains('user')?'user':'assistant',text:(m.textContent||'').trim()};}));})()`;
      const sendMsg = async (t: string) => {
        await wc.executeJavaScript(`(function(){var ti=document.getElementById('text-input');ti.value=${JSON.stringify(t)};ti.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})(); true;`);
      };
      (async () => {
        try {
          await wc.executeJavaScript(
            `(function(){document.querySelectorAll('.overlay,#onboard-overlay,#settings-overlay').forEach(function(e){e.classList.remove('visible');});` +
            `var c=document.createElement('canvas');c.width=160;c.height=120;var g=c.getContext('2d');g.fillStyle='#123';g.fillRect(0,0,160,120);` +
            `window.__fakeStream=c.captureStream(2);` +
            `navigator.mediaDevices.getDisplayMedia=function(){return Promise.resolve(window.__fakeStream);};})(); true;`,
          );
          // Build real history: two normal turns (the mock LLM replies so onDone
          // appends them to the coordinator's shared history).
          await sendMsg('alpha first message'); await delay(500);
          await sendMsg('bravo second message'); await delay(500);
          console.log('[ARIA_VERIFY] convo-before=' + (await wc.executeJavaScript(snap)));
          // Activate screen share, then send a message WHILE sharing (image
          // attached). The mock server records the messages array it receives.
          await wc.executeJavaScript(`(function(){var b=document.getElementById('screen-btn'); if(b) b.click();})(); true;`);
          await delay(1000);
          await sendMsg('describe my screen please'); await delay(800);
          console.log('[ARIA_VERIFY] convo-after=' + (await wc.executeJavaScript(snap)));
        } catch (e) {
          console.log('[ARIA_VERIFY] error: ' + (e as Error).message);
        }
        await supervisor.stopAll();
        app.exit(0);
      })();
      return;
    }

    // Routing-invariant verification: configure a (mock) direct LLM + agent harness,
    // drive one tool-requiring message under a chosen routing mode, and capture the
    // final assistant text. Used by scripts/smoke-routing-invariant.js to prove the
    // direct LLM is never offered tools and that tool-requiring requests route to
    // the harness up front (the delegation decision lives in routing, not a tool).
    if (process.env.ARIA_VERIFY_ROUTING && mainWindow) {
      const wc = mainWindow.webContents;
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      if (process.env.ARIA_VERIFY_LLM_ENDPOINT) config.set('llm.endpoint', process.env.ARIA_VERIFY_LLM_ENDPOINT);
      if (process.env.ARIA_VERIFY_HARNESS_ENDPOINT) config.set('harness.endpoint', process.env.ARIA_VERIFY_HARNESS_ENDPOINT);
      config.set('llm.model', 'mock-llm');
      config.set('harness.model', 'mock-harness');
      config.set('routing.mode', process.env.ARIA_VERIFY_ROUTING_MODE || 'auto');
      (async () => {
        try {
          await wc.executeJavaScript(
            `(function(){document.querySelectorAll('.overlay,#onboard-overlay,#settings-overlay').forEach(function(e){e.classList.remove('visible');});` +
            `})(); true;`,
          );
          // ARIA_VERIFY_ROUTING_MSGS (JSON array) replays a multi-turn exchange,
          // each turn after the previous reply lands; MSG is the one-turn form.
          const msgs: string[] = process.env.ARIA_VERIFY_ROUTING_MSGS
            ? JSON.parse(process.env.ARIA_VERIFY_ROUTING_MSGS)
            : [process.env.ARIA_VERIFY_ROUTING_MSG || 'what is the weather in austin'];
          for (const msg of msgs) {
            await wc.executeJavaScript(
              `(function(){var ti=document.getElementById('text-input');ti.value=${JSON.stringify(msg)};` +
              `ti.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})(); true;`,
            );
            await delay(2500); // route -> stream -> final answer
          }
          const convo = await wc.executeJavaScript(`(function(){return JSON.stringify(Array.from(document.querySelectorAll('#conversation .message')).map(function(m){return {role:m.classList.contains('user')?'user':'assistant',text:(m.textContent||'').trim()};}));})()`);
          console.log('[ARIA_VERIFY] routing-convo=' + convo);
        } catch (e) {
          console.log('[ARIA_VERIFY] error: ' + (e as Error).message);
        }
        await supervisor.stopAll();
        app.exit(0);
      })();
      return;
    }

    // Hover-timestamp verification (Item 6): create two real message bubbles,
    // confirm each carries a data-time and the ::after timestamp is hidden by
    // default, then FORCE :hover on the 2nd bubble via the DevTools protocol and
    // confirm only that bubble's timestamp reveals. Used by scripts/smoke-hover.js.
    if (process.env.ARIA_VERIFY_HOVER && mainWindow) {
      const wc = mainWindow.webContents;
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        try {
          await wc.executeJavaScript(
            `(function(){document.querySelectorAll('.overlay,#onboard-overlay,#settings-overlay').forEach(function(e){e.classList.remove('visible');});` +
            `var ti=document.getElementById('text-input');` +
            `['first message','second message'].forEach(function(t){ti.value=t; ti.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});})(); true;`,
          );
          await delay(250);
          const def = await wc.executeJavaScript(`(function(){var ms=document.querySelectorAll('#conversation .message');var a=ms[0],b=ms[ms.length-1];` +
            `function op(el){return getComputedStyle(el,'::after').opacity;}function ac(el){return getComputedStyle(el,'::after').content;}` +
            `return JSON.stringify({count:ms.length,t0:a&&a.dataset.time,t1:b&&b.dataset.time,op0:op(a),op1:op(b),content1:ac(b)});})()`);
          console.log('[ARIA_VERIFY] hover-default=' + def);

          // The reveal contract: confirm the stylesheet rules. getComputedStyle()
          // doesn't reflect a programmatically forced :hover for pseudo-elements,
          // so we verify the rules directly — default `.message::after` opacity 0
          // and `.message:hover::after` opacity 1, the latter scoped to the
          // hovered .message (so a sibling never reveals).
          const rules = await wc.executeJavaScript(`(function(){var out=[];for(var i=0;i<document.styleSheets.length;i++){var rs;try{rs=document.styleSheets[i].cssRules;}catch(e){continue;}` +
            `for(var j=0;j<rs.length;j++){var sel=rs[j].selectorText||'';if(sel.indexOf('.message')>=0&&sel.indexOf('::after')>=0){out.push({sel:sel,opacity:rs[j].style&&rs[j].style.opacity});}}}return JSON.stringify(out);})()`);
          console.log('[ARIA_VERIFY] hover-rules=' + rules);
        } catch (e) {
          console.log('[ARIA_VERIFY] error: ' + (e as Error).message);
        }
        await supervisor.stopAll();
        app.exit(0);
      })();
      return;
    }

    // Onboarding direct-LLM-provider verification (Item 2): drive a fresh
    // onboarding through the new LLM step against a mock endpoint, then confirm
    // the direct-provider config persisted. Used by scripts/smoke-onboarding-llm.js.
    if (process.env.ARIA_VERIFY_ONBOARD && mainWindow) {
      const ep = process.env.ARIA_VERIFY_LLM_ENDPOINT || '';
      (async () => {
        const wc = mainWindow!.webContents;
        try {
          const hasStep = await wc.executeJavaScript(`!!document.getElementById('onb-llm-endpoint')`);
          console.log('[ARIA_VERIFY] onboarding-has-direct-llm-step=' + hasStep);
          await wc.executeJavaScript(
            `(function(){document.getElementById('onb-llm-endpoint').value=${JSON.stringify(ep)};` +
            `document.getElementById('onb-llm-model').value='mock-model';` +
            `document.getElementById('onb-llm-key').value='sk-verify-123';` +
            `document.getElementById('onb-llm-test').click();})(); true;`,
          );
          await new Promise((r) => setTimeout(r, 1500));
          const testResult = await wc.executeJavaScript(`document.getElementById('onb-llm-test-result').textContent`);
          console.log('[ARIA_VERIFY] llm-test-result=' + JSON.stringify(testResult));
          await wc.executeJavaScript(
            `(function(){var n=document.getElementById('onb-next');n.click();})(); true;`,
          );
          await new Promise((r) => setTimeout(r, 600));
          const ep2 = await wc.executeJavaScript(`aria.config.get('llm.endpoint')`);
          const model2 = await wc.executeJavaScript(`aria.config.get('llm.model')`);
          const key2 = await wc.executeJavaScript(`aria.secure.get('llm-api-key')`);
          const onboarded = await wc.executeJavaScript(`aria.config.get('ui.onboarded')`);
          console.log('[ARIA_VERIFY] persisted-llm-endpoint=' + ep2);
          console.log('[ARIA_VERIFY] persisted-llm-model=' + model2);
          console.log('[ARIA_VERIFY] persisted-llm-key=' + (key2 ? 'set' : 'empty'));
          console.log('[ARIA_VERIFY] onboarded=' + onboarded);
        } catch (e) {
          console.log('[ARIA_VERIFY] error: ' + (e as Error).message);
        }
        await supervisor.stopAll();
        app.exit(0);
      })();
      return;
    }

    setTimeout(async () => {
      let smokeFailed = false;
      // Orb render-loop diagnostics (procedural canvas orb, see orb.js).
      if (process.env.ARIA_FPS && mainWindow) {
        try {
          const r = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
            const start = AriaOrb.getMetrics().frames;
            setTimeout(() => {
              const m = AriaOrb.getMetrics();
              resolve({ fps: (m.frames - start) / 2, particles: m.particles, running: m.running });
            }, 2000);
          })`);
          console.log(`[ARIA_FPS] orb fps=${r.fps} particles=${r.particles} running=${r.running}`);
        } catch (e) { console.log('[ARIA_FPS] orb diagnostics failed:', (e as Error).message); }
      }
      // Offscreen screenshot for UI verification (no visible window).
      if (process.env.ARIA_SMOKE_SHOT && mainWindow) {
        try {
          if (process.env.ARIA_OPEN_SETTINGS) {
            await mainWindow.webContents.executeJavaScript(`document.getElementById('settings-btn').click(); true;`);
            await new Promise((r) => setTimeout(r, 500));
          }
          if (process.env.ARIA_ORB_STATE) {
            const s = process.env.ARIA_ORB_STATE;
            if (!['idle', 'listening', 'processing', 'speaking'].includes(s)) {
              throw new Error(`invalid ARIA_ORB_STATE: ${s}`);
            }
            // Hide onboarding/settings overlays for the rest of this capture:
            // onboarding loads asynchronously and can re-show after removal.
            await mainWindow.webContents.insertCSS(
              '.overlay,.onboard-overlay,#onboard-overlay,#settings-overlay{display:none!important}',
            );
            await mainWindow.webContents.executeJavaScript(`(() => {
              document.querySelectorAll('.overlay,.onboard-overlay,#onboard-overlay,#settings-overlay')
                .forEach((element) => element.remove());
              return true;
            })()`);
            const rendered = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
              const expectedState = ${JSON.stringify(s)};
              const expectedPhase = expectedState === 'processing' ? 'thinking'
                : expectedState === 'speaking' ? 'speaking' : 'consolidated';
              const canvas = document.getElementById('orb-canvas');
              if (!(canvas instanceof HTMLCanvasElement)) {
                reject(new Error('orb canvas unavailable'));
                return;
              }
              if (typeof orbState === 'function') orbState(expectedState);
              else AriaOrb.setState(expectedState);
              if (expectedState === 'speaking') AriaOrb.setLevel(0.7);
              AriaOrb.settle();
              requestAnimationFrame(() => requestAnimationFrame(() => {
                // Startup IPC (presets, wake-word state) can land between the
                // request and the capture; re-assert and settle the requested
                // state so the PNG is deterministic, then verify the adapter.
                if (AriaOrb.getState() !== expectedState) {
                  if (typeof orbState === 'function') orbState(expectedState);
                  else AriaOrb.setState(expectedState);
                }
                AriaOrb.settle();
                const actual = {
                  adapterState: AriaOrb.getState(),
                  bodyState: document.body.dataset.state,
                  canvasState: canvas.dataset.state,
                  phase: AriaOrb.getPhase(),
                  hidden: canvas.hidden,
                  frames: AriaOrb.getMetrics().frames,
                  expansion: AriaOrb.getMetrics().expansion,
                  visibility: document.visibilityState,
                };
                if (actual.adapterState !== expectedState || actual.bodyState !== expectedState
                  || actual.canvasState !== expectedState || actual.phase !== expectedPhase
                  || actual.hidden || actual.frames < 1) {
                  reject(new Error('orb snapshot state mismatch: ' + JSON.stringify(actual)));
                  return;
                }
                resolve(actual);
              }));
            })`);
            // Onboarding loads asynchronously and can re-insert its overlay after
            // the first removal; clear again so the capture shows the orb.
            await new Promise((r) => setTimeout(r, 400));
            await mainWindow.webContents.executeJavaScript(`(() => {
              document.querySelectorAll('.overlay,.onboard-overlay,#onboard-overlay,#settings-overlay')
                .forEach((element) => element.remove());
              AriaOrb.settle();
              return true;
            })()`);
            // A hidden window can hand back its last composited frame; force a
            // repaint and wait for two frames so the PNG shows the cleared DOM.
            mainWindow.webContents.invalidate();
            await mainWindow.webContents.executeJavaScript(
              'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
            );
            await new Promise((r) => setTimeout(r, 250));
            console.log(`[ARIA_SMOKE] orb state verified: ${s} phase=${rendered.phase} frames=${rendered.frames}`);
          }
          if (process.env.ARIA_CHAT_DEMO) {
            // Drive a fake harness turn through the REAL IPC path (route + tool
            // chips + streamed text) so the tool-usage UI can be screenshotted.
            // Click "Skip setup" so the first-run onboarding overlay is dismissed
            // for good (it loads async and otherwise re-shows over the chat).
            await mainWindow.webContents.executeJavaScript(
              `(function(){var s=document.getElementById('onb-skip'); if(s) s.click();` +
              `document.querySelectorAll('.overlay,#onboard-overlay,#settings-overlay').forEach(e=>e.classList.remove('visible'));})(); true;`,
            );
            await new Promise((r) => setTimeout(r, 100));
            const wc = mainWindow.webContents;
            const demoCorrelation = { turnId: 'demo', generationId: 1 };
            wc.send(IPC.LLM_ROUTE, { target: 'harness', name: 'Agent', ...demoCorrelation });
            wc.send(IPC.LLM_TOOL, { name: 'web_search', args: '{"q":"weather Austin"}', ...demoCorrelation });
            wc.send(IPC.LLM_TOOL, { name: 'get_weather', ...demoCorrelation });
            wc.send(IPC.LLM_TOOL, { name: 'web_search', ...demoCorrelation }); // duplicate -> ×2
            for (const tok of ['It’s ', 'sunny ', 'and 75°F ', 'in Austin ', 'right now.']) {
              wc.send(IPC.LLM_TOKEN, { token: tok, ...demoCorrelation });
            }
            await new Promise((r) => setTimeout(r, 300));
            // The first-run onboarding overlay loads async and can re-show after
            // the earlier dismiss — clear it again, then let the (hidden-window)
            // compositor settle so the capture reflects the cleared DOM.
            await wc.executeJavaScript(
              `document.querySelectorAll('.overlay,#onboard-overlay,#settings-overlay').forEach(e=>e.classList.remove('visible')); true;`,
            );
            await new Promise((r) => setTimeout(r, 350));
          }
          const img = await mainWindow.webContents.capturePage();
          require('fs').writeFileSync(process.env.ARIA_SMOKE_SHOT, img.toPNG());
          console.log('[ARIA_SMOKE] screenshot saved:', process.env.ARIA_SMOKE_SHOT);
        } catch (e) {
          console.log('[ARIA_SMOKE] screenshot failed:', (e as Error).message);
          smokeFailed = true;
        }
      }
      // Live UI tests that drive the app over CDP (and kill it themselves) set
      // ARIA_SMOKE_HOLD=1 so sidecars are not torn down under them.
      if (process.env.ARIA_SMOKE_HOLD === '1') { console.log('[ARIA_SMOKE] holding (ARIA_SMOKE_HOLD)'); return; }
      console.log('[ARIA_SMOKE] shutting down');
      await supervisor.stopAll();
      console.log(smokeFailed ? '[ARIA_SMOKE] FAIL' : '[ARIA_SMOKE] OK');
      app.exit(smokeFailed ? 1 : 0);
    }, 4000);
  }
});

// One-time migration: the TTS default moved from Piper to Kokoro. An older
// config that still pins engine=piper while selecting a Kokoro voice (af_/am_/
// bf_/bm_) would silently keep playing Piper — flip it to Kokoro.
function migrateConfig(): void {
  const eng = config.get('tts.engine') as string;
  const voice = (config.get('tts.voice') as string) || '';
  if (eng === 'piper' && /^(af_|am_|bf_|bm_)/.test(voice)) {
    config.set('tts.engine', 'kokoro');
  }
  // The UI redesign replaced the old system/light/dark themes with named ones
  // (midnight, nord, …). A legacy 'system'/'dark' value is no longer a dropdown
  // option, so it left the Theme select blank and applied an unstyled
  // data-theme. Map the dead values to the new default so existing installs
  // (and the old config default) land on a real theme.
  const theme = config.get('ui.theme') as string;
  if (theme === 'system' || theme === 'dark') {
    config.set('ui.theme', 'midnight');
  }
}

// Flip the active resource preset to 'custom' when the user hand-edits one of the
// preset-managed settings (STT model/backend, TTS engine/voice, GPU cap), so the
// UI reflects that they've diverged from the preset. Writes done BY a preset go
// through applyResourcePreset (config.set directly), never this IPC path, so they
// don't trip this.
function markCustomIfManaged(): void {
  if (config.get('ui.perfPreset') !== 'custom') config.set('ui.perfPreset', 'custom');
}

// Persist a resolved preset's concrete bundle (STT model/backend, TTS engine/
// voice, GPU cap) to config. Shared by the Settings-driven applyResourcePreset
// and the startup applyStartupPreset; neither writes ui.perfPreset, so the active
// preset label is preserved. No sidecar reload here — callers decide.
function writeProfileToConfig(p: ResourceProfile): void {
  config.set('stt.model', p.sttModel);
  config.set('stt.backend', p.sttBackend);
  config.set('tts.engine', p.ttsEngine);
  config.set('tts.voice', p.ttsVoice);
  config.set('ui.gpuCap', p.gpuCapPct);
}

// On startup, make the active resource preset REAL. The default preset is 'auto'
// (hardware-adaptive), but it was previously only resolved when the user re-picked
// a preset in Settings — so a fresh install ran at the DEFAULT gpuCap (50)
// regardless of hardware. perfProfile maps cap<=60 to MEDIUM orb quality (idle
// capped ~25 FPS), so even a capable GPU rendered a visibly choppy orb. Resolving
// the preset here (anything but 'custom') and persisting its bundle BEFORE
// applyConfigToEnv reads gpuCap makes 'auto' on high-tier hardware yield
// gpuCap=100 -> HIGH orb quality (native-refresh while focused). No reload is
// needed: sidecars haven't lazy-started yet and read the fresh config on first
// spawn. 'custom' is skipped so hand-picked settings are never overwritten.
function applyStartupPreset(): void {
  const preset = config.get('ui.perfPreset');
  if (!isPerfPreset(preset) || preset === 'custom') return;
  const p = resolveProfile(preset, detectHardware());
  writeProfileToConfig(p);
  console.log(
    `[ARIA] startup preset '${preset}' -> stt=${p.sttModel}/${p.sttBackend} ` +
    `tts=${p.ttsEngine}/${p.ttsVoice} orb=${p.orbQuality} gpuCap=${p.gpuCapPct}%`,
  );
}

// Apply a resource preset: resolve it against the detected hardware, persist the
// concrete bundle (STT model/backend, TTS engine/voice, GPU cap), and reload the
// STT + TTS sidecars so the change is REAL — a different model/backend/voice
// actually runs, not just a label. 'custom' is a no-op (keeps manual settings).
async function applyResourcePreset(preset: PerfPreset): Promise<void> {
  if (!isPerfPreset(preset) || preset === 'custom') return;
  const hw = detectHardware();
  const p = resolveProfile(preset, hw);
  writeProfileToConfig(p);
  console.log(
    `[ARIA] resource preset '${preset}' -> stt=${p.sttModel}/${p.sttBackend} threads=${p.sttThreads} ` +
    `tts=${p.ttsEngine}/${p.ttsVoice} orb=${p.orbQuality} gpuCap=${p.gpuCapPct}%`,
  );
  if (SMOKE || !supervisor) return;
  scheduleSidecarReload('stt');
  scheduleSidecarReload('tts');
}

function applyConfigToEnv(): void {
  migrateConfig();

  // Adaptive, hardware-aware caps. The STT sidecar runs whisper.cpp, the heaviest
  // on-device GPU/CPU consumer; bound its thread count (and, at a very low cap or
  // on a weak GPU, push it to the CPU path) so a transcription can't peg the
  // machine. The user's explicit STT backend choice still wins — we only fill the
  // thread budget and supply the profile's backend as the default.
  const hw = detectHardware();
  const profile = perfProfile(hw, clampCap(config.get('ui.gpuCap')));
  process.env.ARIA_STT_THREADS = String(profile.sttThreads);

  process.env.ARIA_STT_MODEL = (config.get('stt.model') as string) || 'small';
  process.env.ARIA_STT_BACKEND = (config.get('stt.backend') as string) || profile.sttBackend;
  process.env.ARIA_TTS_ENGINE = (config.get('tts.engine') as string) || 'kokoro';
  process.env.ARIA_TTS_VOICE = (config.get('tts.voice') as string) || 'bm_george';
  process.env.ARIA_TTS_SPEED = String((config.get('tts.speed') as number) ?? 1.0);
  process.env.ARIA_WAKEWORD_MODEL = (config.get('wakeword.phrase') as string) || 'hey_jarvis';
  const wwThreshold = config.get('wakeword.threshold');
  if (typeof wwThreshold === 'number') process.env.ARIA_WAKEWORD_THRESHOLD = String(wwThreshold);

  // Point the STT sidecar at the bundled whisper.cpp (binaries + libs) when the
  // app is packaged, so it works without a local whisper.cpp install.
  const whisperDir = path.join(process.resourcesPath || '', 'whisper');
  if (fs.existsSync(whisperDir)) {
    process.env.ARIA_WHISPER_BIN_DIR = path.join(whisperDir, 'bin');
    process.env.ARIA_WHISPER_LIB_DIR = path.join(whisperDir, 'lib');
  }
}

// Coalesce rapid wake-word config changes (the save handler writes the phrase
// and the enabled flag back to back) into a single sidecar reload.
let wakewordReloadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleWakewordReload(): void {
  if (wakewordReloadTimer) clearTimeout(wakewordReloadTimer);
  wakewordReloadTimer = setTimeout(() => {
    wakewordReloadTimer = null;
    void applyWakewordConfig();
  }, 300);
}

// Apply a wake-word Settings change live: refresh the env the sidecar inherits,
// then (re)start it with the new model — or stop it if the user disabled the
// wake word — so a typed phrase takes effect without an app restart.
async function applyWakewordConfig(): Promise<void> {
  if (SMOKE || !supervisor) return;
  process.env.ARIA_WAKEWORD_MODEL = (config.get('wakeword.phrase') as string) || 'hey_jarvis';
  const wwThreshold = config.get('wakeword.threshold');
  if (typeof wwThreshold === 'number') process.env.ARIA_WAKEWORD_THRESHOLD = String(wwThreshold);
  try {
    if (config.get('wakeword.enabled')) await supervisor.restart('wakeword');
    else await supervisor.stop('wakeword');
  } catch (e) {
    console.error('[ARIA] wakeword reload failed:', (e as Error).message);
  }
}

// Coalesce rapid Settings changes that affect a sidecar (e.g. stt.model and
// stt.backend saved back to back) into a single reload of that sidecar.
const sidecarReloadTimers: Partial<Record<SidecarName, ReturnType<typeof setTimeout>>> = {};
function scheduleSidecarReload(name: SidecarName): void {
  const existing = sidecarReloadTimers[name];
  if (existing) clearTimeout(existing);
  sidecarReloadTimers[name] = setTimeout(() => {
    delete sidecarReloadTimers[name];
    void applySidecarConfig(name);
  }, 300);
}

// Apply a TTS/STT Settings change live. The sidecars read their model/voice/
// backend from the environment only at spawn, so we refresh the env from the
// current config and restart the sidecar — but only if it has actually been
// started. A not-yet-lazy-started sidecar needs nothing: it will read the fresh
// env when it first spawns; ensureSidecar verifies its models there. Both STT
// models and TTS engine/voice assets must be provisioned before restarting.
async function applySidecarConfig(name: SidecarName): Promise<void> {
  if (!supervisor) return;
  applyConfigToEnv(); // refresh ALL ARIA_* env vars from the current config
  if (!lazyStarted.has(name)) return; // not running yet -> fresh env used on first spawn
  try {
    if (name === 'stt' || name === 'tts') {
      const ok = await ensureModelsReady(); // download the newly-selected model if absent
      if (!ok) return;
    }
    await supervisor.restart(name);
  } catch (e) {
    console.error(`[ARIA] ${name} reload failed:`, (e as Error).message);
  }
}

async function ensureModelsReady(): Promise<boolean> {
  const sttModel = config.get('stt.model') as string;
  const ttsVoice = config.get('tts.voice') as string;
  const ttsEngine = (config.get('tts.engine') as string) || 'kokoro';
  let manifest;
  try {
    manifest = buildManifest(sttModel, ttsVoice, ttsEngine);
  } catch (err) {
    mainWindow?.webContents.send(IPC.MODEL_ERROR, (err as Error).message);
    return false;
  }
  const missing = await missingOrInvalidModels(manifest);

  if (missing.length === 0) return true;

  if (SMOKE) {
    // Don't download multi-GB weights during a headless boot test.
    console.log(`[ARIA_SMOKE] ${missing.length} model(s) missing (skipping download in smoke mode)`);
    return false;
  }

  mainWindow?.webContents.send(IPC.MODEL_NEEDED, missing.map((m) => ({ id: m.id, file: m.file })));

  try {
    for (const spec of missing) {
      await downloadModel(spec, (p) => {
        mainWindow?.webContents.send(IPC.MODEL_PROGRESS, p);
      });
    }
    mainWindow?.webContents.send(IPC.MODEL_DONE);
    return true;
  } catch (err) {
    mainWindow?.webContents.send(IPC.MODEL_ERROR, (err as Error).message);
    return false;
  }
}

const lazyStarted = new Set<SidecarName>();
const sidecarStarts = new Map<SidecarName, Promise<void>>();

async function ensureSidecar(name: SidecarName, timeoutMs = 20000): Promise<void> {
  if (!lazyStarted.has(name)) {
    let start = sidecarStarts.get(name);
    if (!start) {
      start = (async () => {
        if ((name === 'stt' || name === 'tts') && !await ensureModelsReady()) {
          throw new Error(`${name} models are unavailable`);
        }
        await supervisor.start(name);
        lazyStarted.add(name);
      })().finally(() => { sidecarStarts.delete(name); });
      sidecarStarts.set(name, start);
    }
    await start;
  }
  // Block until the sidecar has loaded its model and emitted 'ready'. Without
  // this the first 'synthesize'/'transcribe' could reach the process before
  // initialize() finished, hitting a not-yet-loaded model (the first-utterance
  // "'NoneType' object has no attribute 'create'" race).
  await supervisor.waitForReady(name, timeoutMs);
}

function routeSidecarMessage(name: SidecarName, msg: Record<string, unknown>): void {
  const type = msg.type as string;
  switch (type) {
    case 'stt_started': {
      const turnId = typeof msg.utterance_id === 'string' ? msg.utterance_id : '';
      const action = sttGate.ackStarted(turnId);
      if (!action) break;
      sttActiveTurn = turnId;
      for (const chunk of action.chunks) supervisor.sendPcm('stt', chunk);
      if (action.transcribe) sendSttTranscribe(action.transcribe);
      break;
    }
    case 'stt_result':
      {
        const turnId = typeof msg.utterance_id === 'string' ? msg.utterance_id : '';
        if (!sttGate.acceptResult(turnId)) break;
        if (sttActiveTurn === turnId) sttActiveTurn = null;
        const waiter = sttWaiters.get(turnId);
        if (waiter) { sttWaiters.delete(turnId); waiter.resolve(typeof msg.text === 'string' ? msg.text : ''); break; }
        perfMark(turnId, 'stt_result', { chars: typeof msg.text === 'string' ? msg.text.length : 0, reused: msg.reused === true });
        mainWindow?.webContents.send(IPC.STT_RESULT, { text: msg.text, turnId });
      }
      break;
    case 'stt_partial':
      {
        const turnId = typeof msg.utterance_id === 'string' ? msg.utterance_id : '';
        if (sttGate.isCurrent(turnId) && typeof msg.text === 'string') {
          perfMark(turnId, 'stt_partial', { chars: msg.text.length });
          mainWindow?.webContents.send(IPC.STT_PARTIAL, { text: msg.text, turnId });
        }
      }
      break;
    case 'stt_failed':
      {
        const turnId = typeof msg.utterance_id === 'string' ? msg.utterance_id : '';
        if (sttActiveTurn === turnId) sttActiveTurn = null;
        const failed = sttWaiters.get(turnId);
        if (failed) { sttWaiters.delete(turnId); sttGate.failStart(turnId); failed.reject(new Error(String(msg.error || msg.detail || 'Speech recognition failed'))); break; }
        if (sttGate.failStart(turnId)) {
          mainWindow?.webContents.send(IPC.STT_STATE, { state: 'stt_failed', turnId, error: msg.error || msg.detail || 'Speech recognition failed' });
        }
      }
      break;
    case 'wakeword_detected':
      // Forward the confidence too: the renderer requires a stronger score to
      // barge in on ARIA's own speech than to wake it from idle, so leaked TTS
      // audio / marginal room noise can't self-interrupt a reply mid-sentence.
      mainWindow?.webContents.send(IPC.WAKEWORD_DETECTED, msg.phrase, msg.score);
      void ensureSidecar('stt').catch((e) => console.error('[ARIA] STT wake prewarm failed:', (e as Error).message));
      break;
    case 'tts_chunk':
      {
        const replyId = typeof msg.reply_id === 'string' ? msg.reply_id : '';
        const requestId = typeof msg.request_id === 'string' ? msg.request_id : '';
        const epoch = Number(msg.epoch);
        const size = Number(msg.size);
        const sampleRate = Number(msg.sample_rate);
        deliverTtsPackets(ttsAudioGate.announce({ replyId, requestId, epoch, size, sampleRate }));
      }
      break;
    case 'tts_done':
      if (isLatencyTestId(msg.reply_id)) break;
      mainWindow?.webContents.send(IPC.TTS_STATE, {
        state: 'request_done',
        replyId: msg.reply_id,
        requestId: msg.request_id,
        epoch: msg.epoch,
      });
      break;
    case 'tts_reply_done':
      {
        const replyId = typeof msg.reply_id === 'string' ? msg.reply_id : '';
        const epoch = Number(msg.epoch);
        ttsAudioGate.markReplyDone(replyId, epoch);
        deliverTtsPackets([]);
      }
      break;
  }
}

app.on('before-quit', async (e) => {
  isQuitting = true; // let the window's close handler actually close
  globalShortcut.unregisterAll();
  // Tear down the SSH tunnel on quit so the ssh process doesn't outlive
  // the app. The supervisor's stop() is synchronous (it just sends
  // SIGTERM to the child) — the await is on the sidecar stopAll.
  try { tunnel.stop(); } catch (e) { /* nothing to do */ }
  // An AppImage self-update is relaunching: electron-updater's beforeInstall hook
  // already stopped the sidecars, so let the quit proceed normally (a hard
  // app.exit here would cancel the staged install + relaunch).
  if (isInstallingUpdate()) return;
  e.preventDefault();
  await supervisor.stopAll();
  app.exit(0);
});

app.on('window-all-closed', () => {
  // Keep running in tray on Linux
});

app.on('activate', () => { showMainWindow(); });

// Single-instance: relaunching ARIA (e.g. clicking its taskbar/launcher icon
// while it runs in the background) restores the existing window instead of
// starting a second copy.
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => { showMainWindow(); });

process.on('SIGTERM', async () => {
  await supervisor.stopAll();
  app.exit(0);
});

process.on('SIGINT', async () => {
  await supervisor.stopAll();
  app.exit(0);
});
