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
    start: () => ipcRenderer.send(IPC.STT_START),
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
    send: (message: string) => ipcRenderer.send(IPC.LLM_SEND, message),
    test: (opts: { endpoint: string; model: string; apiKey?: string }) =>
      ipcRenderer.invoke(IPC.LLM_TEST, opts),
    onToken: (cb: (token: string) => void) =>
      ipcRenderer.on(IPC.LLM_TOKEN, (_e, token) => cb(token)),
    onDone: (cb: (fullText: string) => void) =>
      ipcRenderer.on(IPC.LLM_DONE, (_e, text) => cb(text)),
    onError: (cb: (error: string) => void) =>
      ipcRenderer.on(IPC.LLM_ERROR, (_e, error) => cb(error)),
    onRoute: (cb: (info: { target: string; name: string }) => void) =>
      ipcRenderer.on(IPC.LLM_ROUTE, (_e, info) => cb(info)),
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
};

contextBridge.exposeInMainWorld('aria', api);
