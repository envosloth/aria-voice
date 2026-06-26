import path from 'path';
import os from 'os';

export const APP_NAME = 'ARIA';

export const SOCKET_DIR = path.join(os.tmpdir(), 'aria');

export const SIDECAR_NAMES = ['stt', 'tts', 'wakeword'] as const;
export type SidecarName = typeof SIDECAR_NAMES[number];

export const HEARTBEAT_INTERVAL_MS = 5000;
export const HEARTBEAT_TIMEOUT_MS = 10000;
export const MAX_RESTART_ATTEMPTS = 5;
export const RESTART_BACKOFF_BASE_MS = 1000;
// After the circuit breaker trips (too many rapid crashes), wait this long then
// reset it and retry once — so a transient burst of failures doesn't disable a
// sidecar (e.g. the wake word) permanently until the app is restarted.
export const CIRCUIT_RESET_MS = 60000;

export const RSS_LIMITS_MB: Record<SidecarName, number> = {
  stt: 2048,
  tts: 1024,
  wakeword: 512,
};

export const MEMORY_CHECK_INTERVAL_MS = 30000;

export const STT_MODELS = {
  'base.en': { size: '74M', description: 'Fast, English-only' },
  'small': { size: '244M', description: 'Balanced accuracy/speed (default)' },
  'medium': { size: '769M', description: 'Higher accuracy, slower' },
} as const;

export const DEFAULT_STT_MODEL = 'small' as const;

export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_CHANNELS = 1;
export const VAD_FRAME_MS = 80;
