import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

const api = {
  config: {
    get: (key: string) => ipcRenderer.invoke(IPC.CONFIG_GET, key),
    set: (key: string, value: unknown) => ipcRenderer.invoke(IPC.CONFIG_SET, key, value),
  },

  secure: {
    getBackend: () => ipcRenderer.invoke(IPC.SECURE_BACKEND),
    get: (key: string) => ipcRenderer.invoke(IPC.SECURE_STORE_GET, key),
    set: (key: string, value: string) => ipcRenderer.invoke(IPC.SECURE_STORE_SET, key, value),
    delete: (key: string) => ipcRenderer.invoke(IPC.SECURE_STORE_DELETE, key),
  },

  mic: {
    sendAudio: (pcm: ArrayBuffer) => ipcRenderer.send(IPC.MIC_AUDIO, pcm),
  },

  stt: {
    start: (turnId?: string) => ipcRenderer.send(IPC.STT_START, turnId || ''),
    end: () => ipcRenderer.send(IPC.STT_END),
    onResult: (cb: (text: string) => void) =>
      ipcRenderer.on(IPC.STT_RESULT, (_e, text) => cb(text)),
    onPartial: (cb: (text: string) => void) =>
      ipcRenderer.on(IPC.STT_PARTIAL, (_e, text) => cb(text)),
    onState: (cb: (state: string) => void) =>
      ipcRenderer.on(IPC.STT_STATE, (_e, state) => cb(state)),
  },

  tts: {
    play: (text: string) => ipcRenderer.send(IPC.TTS_PLAY, text),
    stop: () => ipcRenderer.send(IPC.TTS_STOP),
    onAudio: (cb: (pcm: ArrayBuffer) => void) =>
      ipcRenderer.on(IPC.TTS_AUDIO, (_e, pcm: Buffer) => {
        const copy = new Uint8Array(pcm.byteLength);
        copy.set(pcm);
        cb(copy.buffer);
      }),
    onState: (cb: (state: unknown) => void) =>
      ipcRenderer.on(IPC.TTS_STATE, (_e, state) => cb(state)),
  },

  wakeword: {
    onDetected: (cb: (phrase: string) => void) =>
      ipcRenderer.on(IPC.WAKEWORD_DETECTED, (_e, phrase) => cb(phrase)),
    onState: (cb: (state: string) => void) =>
      ipcRenderer.on(IPC.WAKEWORD_STATE, (_e, state) => cb(state)),
  },

  llm: {
    send: (message: string, image?: string | null, turnId?: string) =>
      ipcRenderer.send(IPC.LLM_SEND, { message, image: image || null, turnId: turnId || '' }),
    cancel: () => ipcRenderer.send(IPC.LLM_CANCEL),
    test: (opts: { endpoint: string; model: string; apiKey?: string }) =>
      ipcRenderer.invoke(IPC.LLM_TEST, opts),
    // Auto-discover the model served by an OpenAI-compatible endpoint (Hermes
    // on :8642, Ollama on :11434, LM Studio on :1234, vLLM, etc.). Settings'
    // "Discover model" button calls this and pre-fills the model field. Returns
    // { ok, models[], recommended?, endpoint, error? }.
    listModels: (opts: { endpoint: string; apiKey?: string }) =>
      ipcRenderer.invoke(IPC.LLM_LIST_MODELS, opts),
    onToken: (cb: (token: string) => void) =>
      ipcRenderer.on(IPC.LLM_TOKEN, (_e, token) => cb(token)),
    onTool: (cb: (info: { name: string; args?: string }) => void) =>
      ipcRenderer.on(IPC.LLM_TOOL, (_e, info) => cb(info)),
    onDone: (cb: (fullText: string) => void) =>
      ipcRenderer.on(IPC.LLM_DONE, (_e, text) => cb(text)),
    onError: (cb: (error: string) => void) =>
      ipcRenderer.on(IPC.LLM_ERROR, (_e, error) => cb(error)),
    onRoute: (cb: (info: { target: string; name: string }) => void) =>
      ipcRenderer.on(IPC.LLM_ROUTE, (_e, info) => cb(info)),
  },

  // Latency instrumentation bridge (see src/main/perf.ts). `enabled()` is queried
  // once at startup; `mark()` is fire-and-forget (ipcRenderer.send never blocks
  // the renderer) so instrumenting the hot path can't add latency to it.
  perf: {
    enabled: () => ipcRenderer.invoke(IPC.PERF_ENABLED),
    mark: (turnId: string, stage: string, extra?: Record<string, unknown>) =>
      ipcRenderer.send(IPC.PERF_MARK, { turn: turnId, stage, t: Date.now(), extra }),
  },

  // Detected host hardware + the adaptive performance profile for the current GPU
  // cap (see src/main/hardware.ts). Used by the Settings → Performance panel.
  hardware: {
    info: () => ipcRenderer.invoke(IPC.HARDWARE_INFO),
  },

  // In-app updates (see src/main/updater.ts). `current()` reports the running
  // version + delivery channel; `check()` looks for a newer release; `install()`
  // applies a downloaded AppImage update; `openRelease()` opens the download page.
  updates: {
    current: () => ipcRenderer.invoke(IPC.UPDATE_CURRENT),
    check: () => ipcRenderer.send(IPC.UPDATE_CHECK),
    install: () => ipcRenderer.send(IPC.UPDATE_INSTALL),
    openRelease: (url?: string) => ipcRenderer.send(IPC.UPDATE_OPEN, url || ''),
    onStatus: (cb: (s: Record<string, unknown>) => void) =>
      ipcRenderer.on(IPC.UPDATE_STATUS, (_e, s) => cb(s)),
  },

  sidecar: {
    onStatus: (cb: (info: { name: string; status: string; detail?: string }) => void) =>
      ipcRenderer.on(IPC.SIDECAR_STATUS, (_e, info) => cb(info)),
    onError: (cb: (info: { name: string; status: string; detail?: string }) => void) =>
      ipcRenderer.on(IPC.SIDECAR_ERROR, (_e, info) => cb(info)),
  },

  models: {
    onNeeded: (cb: (list: { id: string; file: string }[]) => void) =>
      ipcRenderer.on(IPC.MODEL_NEEDED, (_e, list) => cb(list)),
    onProgress: (cb: (p: { id: string; file: string; received: number; total: number; percent: number }) => void) =>
      ipcRenderer.on(IPC.MODEL_PROGRESS, (_e, p) => cb(p)),
    onDone: (cb: () => void) => ipcRenderer.on(IPC.MODEL_DONE, () => cb()),
    onError: (cb: (msg: string) => void) =>
      ipcRenderer.on(IPC.MODEL_ERROR, (_e, msg) => cb(msg)),
  },

  // Remote access (SSH tunnel) — see src/main/tunnel-supervisor.ts. The
  // status is pushed to the renderer on every state change (connected /
  // reconnecting / error / …); the renderer subscribes via `onStatus`
  // and renders a banner with a "Copy URL" button + Connect/Disconnect
  // controls. `snapshot()` reads the latest state synchronously (used
  // when the Settings panel first opens).
  tunnel: {
    snapshot: () => ipcRenderer.invoke(IPC.TUNNEL_SNAPSHOT),
    start: () => ipcRenderer.send(IPC.TUNNEL_START),
    stop: () => ipcRenderer.send(IPC.TUNNEL_STOP),
    onStatus: (cb: (s: Record<string, unknown>) => void) =>
      ipcRenderer.on(IPC.TUNNEL_STATUS, (_e, s) => cb(s)),
  },
};

contextBridge.exposeInMainWorld('aria', api);
