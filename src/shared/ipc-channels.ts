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
  LLM_CANCEL: 'llm:cancel',     // renderer -> main: abort the in-flight generation (barge-in)
  LLM_RESET: 'llm:reset',       // renderer -> main: clear conversation history (New session)
  LLM_TOKEN: 'llm:token',
  LLM_TOOL: 'llm:tool',        // main -> renderer: a tool the harness invoked (shown above the reply)
  LLM_DONE: 'llm:done',
  LLM_ERROR: 'llm:error',
  // Discover models served by an OpenAI-compatible endpoint (Hermes, Ollama, LM
  // Studio, vLLM…). Used by Settings to auto-fill the model field on the harness
  // (Hermes on :8642) or LLM (any other). Returns the default-recommended model.
  LLM_LIST_MODELS: 'llm:list-models',
  LLM_TEST: 'llm:test',        // renderer -> main: test a provider endpoint/key
  // Auto-detect a local harness's endpoint + API key from the config it wrote on
  // disk (e.g. Hermes' ~/.hermes/.env), so users don't have to find the key.
  LLM_DETECT_HARNESS: 'llm:detect-harness',
  LLM_ROUTE: 'llm:route',      // main -> renderer: which target answered (llm|harness)

  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',

  SESSIONS_LIST: 'sessions:list',     // renderer -> main: summaries of past conversations
  SESSIONS_GET: 'sessions:get',       // renderer -> main: full transcript of one session
  SESSIONS_DELETE: 'sessions:delete', // renderer -> main: remove a saved session

  SECURE_STORE_GET: 'secure:get',
  SECURE_STORE_SET: 'secure:set',
  SECURE_STORE_DELETE: 'secure:delete',
  SECURE_BACKEND: 'secure:backend',

  PERF_ENABLED: 'perf:enabled',  // renderer -> main: is latency instrumentation on?
  PERF_MARK: 'perf:mark',        // renderer -> main: a latency stage mark to log

  HARDWARE_INFO: 'hardware:info', // renderer -> main: detected CPU/RAM/GPU + adaptive perf profile

  UPDATE_CHECK: 'update:check',     // renderer -> main: check GitHub for a newer release
  UPDATE_INSTALL: 'update:install', // renderer -> main: install a downloaded update + relaunch (AppImage)
  UPDATE_OPEN: 'update:open',       // renderer -> main: open the release page in the browser (deb/dev)
  UPDATE_STATUS: 'update:status',   // main -> renderer: checking|available|downloading|downloaded|not-available|error
  UPDATE_CURRENT: 'update:current', // renderer -> main: current app version + delivery channel

  // Remote access (SSH tunnel for the harness/llm endpoint).
  TUNNEL_STATUS: 'tunnel:status',   // main -> renderer: every state transition
  TUNNEL_START:  'tunnel:start',    // renderer -> main: start the tunnel (manual)
  TUNNEL_STOP:   'tunnel:stop',     // renderer -> main: stop the tunnel (manual)
  TUNNEL_SNAPSHOT: 'tunnel:snapshot', // renderer -> main: read the latest snapshot
} as const;
