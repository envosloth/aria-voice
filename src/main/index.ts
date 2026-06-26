import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { Supervisor } from './supervisor';
import { config } from './config';
import { getSecureBackend, isSecureBackendSafe, setSecret, getSecret, deleteSecret } from './secure-storage';
import { streamChat } from './llm-stream';
import { coordinate, cancelCoordination } from './coordinator';
import { buildManifest, missingModels, downloadModel } from './model-manager';
import { perfEnabled, setPerfEnabled, perfMark, perfMarkExternal } from './perf';
import { IPC } from '../shared/ipc-channels';
import { SidecarName } from '../shared/constants';

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

// NOTE: we intentionally keep vsync ENABLED. Disabling it (to chase uncapped
// FPS) made the orb tear/shake; the render is cheap (~0.2ms/frame) so vsync at
// the display's native refresh (60/120/160 Hz) is already smooth and stable.
// Orb motion is time-based (see orb.js) so it looks identical at any refresh.

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let supervisor: Supervisor;
let isQuitting = false;

const SMOKE = process.env.ARIA_SMOKE === '1';

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
// recovers the GPU process on its own and the orb's continuous rAF loop
// repaints the canvas on the next frame, so we just log it loudly.
app.on('child-process-gone', (_e, details) => {
  console.error(`[ARIA] child-process-gone: type=${details.type} reason=${details.reason}`);
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
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
  // 'clean-exit' is a normal teardown (e.g. quit) and is left alone.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[ARIA] renderer gone:', details.reason);
    if (!isQuitting && details.reason !== 'clean-exit' && !win.isDestroyed()) {
      win.reload();
    }
  });

  // A hung renderer (Chromium fires this after ~30s of an unresponsive UI) is
  // recovered by reloading rather than leaving a frozen window — another path to
  // "it locked up while I was using it".
  win.on('unresponsive', () => {
    console.error('[ARIA] renderer unresponsive — reloading');
    if (!isQuitting && !win.isDestroyed()) { try { win.reload(); } catch { /* nothing else to do */ } }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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
  const icon = nativeImage.createEmpty();
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

// Focused fallback: when the window has focus, intercept the same chord via
// before-input-event so the hotkey still works even if the global portal failed.
function registerInWindowShortcut(): void {
  if (!mainWindow) return;
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    // Match Super+Shift+A (the configured default chord)
    if (input.meta && input.shift && input.key.toLowerCase() === 'a') {
      toggleListening();
    }
  });
}

function setupIpcHandlers(): void {
  ipcMain.handle(IPC.CONFIG_GET, (_e, key: string) => config.get(key));
  ipcMain.handle(IPC.CONFIG_SET, (_e, key: string, value: unknown) => {
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
      scheduleSidecarReload('tts');
    } else if (key === 'stt.model' || key === 'stt.backend') {
      scheduleSidecarReload('stt');
    }
  });

  ipcMain.handle(IPC.SECURE_BACKEND, () => ({
    backend: getSecureBackend(),
    safe: isSecureBackendSafe(),
  }));
  ipcMain.handle(IPC.SECURE_STORE_GET, (_e, key: string) => getSecret(key));
  ipcMain.handle(IPC.SECURE_STORE_SET, (_e, key: string, value: string) => setSecret(key, value));
  ipcMain.handle(IPC.SECURE_STORE_DELETE, (_e, key: string) => deleteSecret(key));

  ipcMain.on(IPC.LLM_SEND, (_e, payload: string | { message: string; image?: string | null; turnId?: string }) => {
    const message = typeof payload === 'string' ? payload : payload.message;
    const image = typeof payload === 'string' ? null : (payload.image || null);
    const turnId = typeof payload === 'string' ? '' : (payload.turnId || '');
    perfMark(turnId, 'main_recv', image ? { image: 1 } : undefined);
    coordinate(message, {
      onRoute: (info) => mainWindow?.webContents.send(IPC.LLM_ROUTE, info),
      onToken: (token) => mainWindow?.webContents.send(IPC.LLM_TOKEN, token),
      onTool: (info) => mainWindow?.webContents.send(IPC.LLM_TOOL, info),
      onDone: (text) => mainWindow?.webContents.send(IPC.LLM_DONE, text),
      onError: (err) => mainWindow?.webContents.send(IPC.LLM_ERROR, err),
    }, { image, turnId });
  });

  // Latency instrumentation (see perf.ts): the renderer asks once whether marks
  // are enabled, then fire-and-forgets stage marks that we log in one timeline.
  ipcMain.handle(IPC.PERF_ENABLED, () => perfEnabled());
  ipcMain.on(IPC.PERF_MARK, (_e, m: { turn: string; stage: string; t?: number; extra?: Record<string, unknown> }) => {
    perfMarkExternal(m);
  });

  // Barge-in: the renderer heard the wake word (or push-to-talk) while a reply
  // was still streaming — abort generation so ARIA stops talking and listens.
  ipcMain.on(IPC.LLM_CANCEL, () => cancelCoordination());

  ipcMain.on(IPC.TTS_PLAY, async (_e, text: string) => {
    try {
      await ensureSidecar('tts');
      supervisor.sendToSidecar('tts', { type: 'synthesize', text });
    } catch (e) {
      console.error('[ARIA] TTS play failed:', (e as Error).message);
    }
  });

  ipcMain.on(IPC.TTS_STOP, () => {
    supervisor.sendToSidecar('tts', { type: 'stop' });
  });

  // Onboarding "Test connection": one short non-streaming round-trip to confirm
  // the endpoint + key work. Returns {ok} or {ok:false, error}.
  ipcMain.handle(IPC.LLM_TEST, async (_e, opts: { endpoint: string; model: string; apiKey?: string }) => {
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

  // Mic PCM from the renderer (getUserMedia, 16kHz mono s16le). Always feed the
  // always-on wake-word sidecar; also feed STT while an utterance is active.
  ipcMain.on(IPC.MIC_AUDIO, (_e, chunk: ArrayBuffer) => {
    const buf = Buffer.from(chunk);
    if (config.get('wakeword.enabled')) supervisor.sendPcm('wakeword', buf);
    if (sttListening) supervisor.sendPcm('stt', buf);
  });

  ipcMain.on(IPC.STT_START, async (_e, turnId?: string) => {
    sttTurnId = turnId || '';
    perfMark(sttTurnId, 'stt_start');
    try {
      await ensureSidecar('stt');
      supervisor.sendToSidecar('stt', { type: 'reset' });
      sttListening = true;
    } catch (e) {
      console.error('[ARIA] STT start failed:', (e as Error).message);
    }
  });

  ipcMain.on(IPC.STT_END, () => {
    sttListening = false;
    perfMark(sttTurnId, 'stt_transcribe_req');
    supervisor.sendToSidecar('stt', { type: 'transcribe' });
  });
}

let sttListening = false;
// Turn id of the in-flight voice utterance (from the renderer), so the STT
// stage marks join the same timeline as that turn's later LLM/TTS marks.
let sttTurnId = '';

app.whenReady().then(async () => {
  supervisor = new Supervisor(
    (name: SidecarName, status: string, detail?: string) => {
      mainWindow?.webContents.send(IPC.SIDECAR_STATUS, { name, status, detail });
      if (status === 'error' || status === 'circuit-open') {
        mainWindow?.webContents.send(IPC.SIDECAR_ERROR, { name, status, detail });
      }
      if (SMOKE) console.log(`[ARIA_SMOKE][${name}] ${status}${detail ? ': ' + detail : ''}`);
    },
    (name: SidecarName, msg: Record<string, unknown>) => {
      routeSidecarMessage(name, msg);
    },
  );

  supervisor.onBinaryData((name: SidecarName, data: Buffer) => {
    // TTS PCM stream -> renderer for playback (size announced via tts_chunk).
    if (name === 'tts') {
      mainWindow?.webContents.send(IPC.TTS_AUDIO, data);
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
      desktopCapturer.getSources({ types: ['screen'] }).then((sources: unknown[]) => {
        callback(sources.length ? { video: sources[0] } : undefined);
      }).catch(() => callback(undefined));
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

  supervisor.startMonitoring();

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
    setTimeout(() => { void ensureSidecar('stt'); }, 2500);
  }

  // Pre-warm TTS too (staggered after STT to avoid a load spike), so the first
  // reply doesn't pay the model-load + ONNX cold-start cost mid-conversation —
  // the dominant chunk of the text->audio delay. The sidecar runs a throwaway
  // synthesis on load, so by 'ready' the graph is hot.
  if (modelsOk && !SMOKE && config.get('tts.prewarm') !== false) {
    setTimeout(() => { void ensureSidecar('tts'); }, 3500);
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
            `(function(){var n=document.getElementById('onb-next');for(var i=0;i<6;i++)n.click();})(); true;`,
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
      // Orb render benchmark (throttle-independent — times N renders).
      if (process.env.ARIA_FPS && mainWindow) {
        try {
          const r = await mainWindow.webContents.executeJavaScript('AriaOrb.benchmark(400)');
          console.log(`[ARIA_FPS] orb render ${r.avgMs}ms/frame -> sustains ${r.maxFps} FPS (n=${r.n})`);
        } catch (e) { console.log('[ARIA_FPS] benchmark failed:', (e as Error).message); }
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
            // Dismiss onboarding/settings overlays so the orb is unobstructed.
            await mainWindow.webContents.executeJavaScript(
              `document.querySelectorAll('.overlay,#onboard-overlay,#settings-overlay').forEach(e=>e.classList.remove('visible')); true;`,
            );
            // pump() runs synchronous frames so colour easing/motion settle even
            // though rAF is throttled while the window is hidden.
            const js = s === 'speaking'
              ? `AriaOrb.setState('speaking'); for(let i=0;i<80;i++){AriaOrb.setLevel(0.7); AriaOrb.pump(2);} true;`
              : `AriaOrb.setState('${s}'); AriaOrb.pump(100); true;`;
            await mainWindow.webContents.executeJavaScript(js);
            await new Promise((r) => setTimeout(r, 300));
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
            wc.send(IPC.LLM_ROUTE, { target: 'harness', name: 'Agent' });
            wc.send(IPC.LLM_TOOL, { name: 'web_search', args: '{"q":"weather Austin"}' });
            wc.send(IPC.LLM_TOOL, { name: 'get_weather' });
            wc.send(IPC.LLM_TOOL, { name: 'web_search' }); // duplicate -> ×2
            for (const tok of ['It’s ', 'sunny ', 'and 75°F ', 'in Austin ', 'right now.']) {
              wc.send(IPC.LLM_TOKEN, tok);
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
        } catch (e) { console.log('[ARIA_SMOKE] screenshot failed:', (e as Error).message); }
      }
      console.log('[ARIA_SMOKE] shutting down');
      await supervisor.stopAll();
      console.log('[ARIA_SMOKE] OK');
      app.exit(0);
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
}

function applyConfigToEnv(): void {
  migrateConfig();
  process.env.ARIA_STT_MODEL = (config.get('stt.model') as string) || 'small';
  process.env.ARIA_STT_BACKEND = (config.get('stt.backend') as string) || 'vulkan';
  process.env.ARIA_TTS_ENGINE = (config.get('tts.engine') as string) || 'kokoro';
  process.env.ARIA_TTS_VOICE = (config.get('tts.voice') as string) || 'bm_george';
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
// env when it first spawns. A new STT model is downloaded first (the sidecar
// can't load a missing ggml file).
async function applySidecarConfig(name: SidecarName): Promise<void> {
  if (!supervisor) return;
  applyConfigToEnv(); // refresh ALL ARIA_* env vars from the current config
  if (!lazyStarted.has(name)) return; // not running yet -> fresh env used on first spawn
  try {
    if (name === 'stt') {
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
  const manifest = buildManifest(sttModel, ttsVoice, ttsEngine);
  const missing = missingModels(manifest);

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

async function ensureSidecar(name: SidecarName): Promise<void> {
  if (!lazyStarted.has(name)) {
    lazyStarted.add(name);
    await supervisor.start(name);
  }
  // Block until the sidecar has loaded its model and emitted 'ready'. Without
  // this the first 'synthesize'/'transcribe' could reach the process before
  // initialize() finished, hitting a not-yet-loaded model (the first-utterance
  // "'NoneType' object has no attribute 'create'" race).
  await supervisor.waitForReady(name);
}

function routeSidecarMessage(name: SidecarName, msg: Record<string, unknown>): void {
  const type = msg.type as string;
  switch (type) {
    case 'stt_result':
      perfMark(sttTurnId, 'stt_result', { chars: typeof msg.text === 'string' ? msg.text.length : 0 });
      mainWindow?.webContents.send(IPC.STT_RESULT, msg.text);
      break;
    case 'stt_partial':
      mainWindow?.webContents.send(IPC.STT_PARTIAL, msg.text);
      break;
    case 'wakeword_detected':
      mainWindow?.webContents.send(IPC.WAKEWORD_DETECTED, msg.phrase);
      void ensureSidecar('stt');
      break;
    case 'tts_chunk':
      mainWindow?.webContents.send(IPC.TTS_STATE, { state: 'chunk', ...msg });
      break;
    case 'tts_done':
      mainWindow?.webContents.send(IPC.TTS_STATE, { state: 'done' });
      break;
  }
}

app.on('before-quit', async (e) => {
  isQuitting = true; // let the window's close handler actually close
  e.preventDefault();
  globalShortcut.unregisterAll();
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
