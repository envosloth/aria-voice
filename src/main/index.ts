import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import { Supervisor } from './supervisor';
import { config } from './config';
import { getSecureBackend, isSecureBackendSafe, setSecret, getSecret, deleteSecret } from './secure-storage';
import { streamLlmResponse } from './llm-client';
import { buildManifest, missingModels, downloadModel } from './model-manager';
import { IPC } from '../shared/ipc-channels';
import { SidecarName } from '../shared/constants';

app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'wayland');
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let supervisor: Supervisor;

const SMOKE = process.env.ARIA_SMOKE === '1';

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

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

function createTray(): void {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show ARIA', click: () => mainWindow?.show() },
    { label: 'Start Listening', click: () => toggleListening() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setToolTip('ARIA Voice Assistant');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow?.show());
}

function toggleListening(): void {
  mainWindow?.webContents.send(IPC.WAKEWORD_STATE, 'toggle');
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
  ipcMain.handle(IPC.CONFIG_SET, (_e, key: string, value: unknown) => config.set(key, value));

  ipcMain.handle(IPC.SECURE_BACKEND, () => ({
    backend: getSecureBackend(),
    safe: isSecureBackendSafe(),
  }));
  ipcMain.handle(IPC.SECURE_STORE_GET, (_e, key: string) => getSecret(key));
  ipcMain.handle(IPC.SECURE_STORE_SET, (_e, key: string, value: string) => setSecret(key, value));
  ipcMain.handle(IPC.SECURE_STORE_DELETE, (_e, key: string) => deleteSecret(key));

  ipcMain.on(IPC.LLM_SEND, (_e, message: string) => {
    streamLlmResponse(message, {
      onToken: (token) => mainWindow?.webContents.send(IPC.LLM_TOKEN, token),
      onDone: (text) => mainWindow?.webContents.send(IPC.LLM_DONE, text),
      onError: (err) => mainWindow?.webContents.send(IPC.LLM_ERROR, err),
    });
  });

  ipcMain.on(IPC.TTS_PLAY, async (_e, text: string) => {
    await ensureSidecar('tts');
    supervisor.sendToSidecar('tts', { type: 'synthesize', text });
  });

  ipcMain.on(IPC.TTS_STOP, () => {
    supervisor.sendToSidecar('tts', { type: 'stop' });
  });

  // Mic PCM from the renderer (getUserMedia, 16kHz mono s16le). Always feed the
  // always-on wake-word sidecar; also feed STT while an utterance is active.
  ipcMain.on(IPC.MIC_AUDIO, (_e, chunk: ArrayBuffer) => {
    const buf = Buffer.from(chunk);
    if (config.get('wakeword.enabled')) supervisor.sendPcm('wakeword', buf);
    if (sttListening) supervisor.sendPcm('stt', buf);
  });

  ipcMain.on(IPC.STT_START, async () => {
    await ensureSidecar('stt');
    supervisor.sendToSidecar('stt', { type: 'reset' });
    sttListening = true;
  });

  ipcMain.on(IPC.STT_END, () => {
    sttListening = false;
    supervisor.sendToSidecar('stt', { type: 'transcribe' });
  });
}

let sttListening = false;

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

  setupIpcHandlers();
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

  // Always-on wake-word listener (its models ship bundled). STT and TTS are
  // lazy-loaded on first use (see ensureSidecar) to keep idle memory low — the
  // 16 GiB budget assumes we don't hold every model resident when idle.
  if (modelsOk && config.get('wakeword.enabled')) {
    await supervisor.start('wakeword');
  }

  if (SMOKE) {
    // Headless boot test: confirm the app initialized, then quit cleanly.
    console.log('[ARIA_SMOKE] app ready, window+tray+supervisor initialized');
    setTimeout(async () => {
      console.log('[ARIA_SMOKE] shutting down');
      await supervisor.stopAll();
      console.log('[ARIA_SMOKE] OK');
      app.exit(0);
    }, 4000);
  }
});

function applyConfigToEnv(): void {
  process.env.ARIA_STT_MODEL = (config.get('stt.model') as string) || 'small';
  process.env.ARIA_STT_BACKEND = (config.get('stt.backend') as string) || 'vulkan';
  process.env.ARIA_TTS_ENGINE = (config.get('tts.engine') as string) || 'piper';
  process.env.ARIA_TTS_VOICE = (config.get('tts.voice') as string) || 'en_US-lessac-medium';
  process.env.ARIA_WAKEWORD_MODEL = (config.get('wakeword.phrase') as string) || 'hey_jarvis';
}

async function ensureModelsReady(): Promise<boolean> {
  const sttModel = config.get('stt.model') as string;
  const ttsVoice = config.get('tts.voice') as string;
  const manifest = buildManifest(sttModel, ttsVoice);
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
  if (lazyStarted.has(name)) return;
  lazyStarted.add(name);
  await supervisor.start(name);
}

function routeSidecarMessage(name: SidecarName, msg: Record<string, unknown>): void {
  const type = msg.type as string;
  switch (type) {
    case 'stt_result':
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
  e.preventDefault();
  globalShortcut.unregisterAll();
  await supervisor.stopAll();
  app.exit(0);
});

app.on('window-all-closed', () => {
  // Keep running in tray on Linux
});

app.on('activate', () => {
  if (!mainWindow) mainWindow = createWindow();
  else mainWindow.show();
});

process.on('SIGTERM', async () => {
  await supervisor.stopAll();
  app.exit(0);
});

process.on('SIGINT', async () => {
  await supervisor.stopAll();
  app.exit(0);
});
