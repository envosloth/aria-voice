export const IPC = {
  SIDECAR_STATUS: 'sidecar:status',
  SIDECAR_ERROR: 'sidecar:error',

  MODEL_NEEDED: 'model:needed',      // main -> renderer: first-run downloads starting
  MODEL_PROGRESS: 'model:progress',  // main -> renderer: per-file download progress
  MODEL_DONE: 'model:done',          // main -> renderer: all models ready
  MODEL_ERROR: 'model:error',        // main -> renderer: download failed (e.g. offline)

  MIC_AUDIO: 'mic:audio',       // renderer -> main: raw PCM frames from getUserMedia
  STT_START: 'stt:start',       // renderer -> main: begin an utterance (route mic to STT)
  STT_END: 'stt:end',           // renderer -> main: end utterance, trigger transcription
  STT_RESULT: 'stt:result',
  STT_PARTIAL: 'stt:partial',
  STT_STATE: 'stt:state',

  TTS_PLAY: 'tts:play',     // renderer -> main: request synthesis of text
  TTS_STOP: 'tts:stop',     // renderer -> main: cancel current synthesis
  TTS_AUDIO: 'tts:audio',   // main -> renderer: raw PCM chunk for playback
  TTS_STATE: 'tts:state',   // main -> renderer: chunk/done state events

  WAKEWORD_DETECTED: 'wakeword:detected',
  WAKEWORD_STATE: 'wakeword:state',

  LLM_SEND: 'llm:send',
  LLM_TOKEN: 'llm:token',
  LLM_DONE: 'llm:done',
  LLM_ERROR: 'llm:error',

  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',

  SECURE_STORE_GET: 'secure:get',
  SECURE_STORE_SET: 'secure:set',
  SECURE_STORE_DELETE: 'secure:delete',
  SECURE_BACKEND: 'secure:backend',
} as const;
