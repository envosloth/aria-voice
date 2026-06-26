import { JsonStore } from './json-store';
import { DEFAULT_STT_MODEL } from '../shared/constants';

interface AppConfig {
  stt: {
    model: string;
    backend: 'vulkan' | 'cpu';
    prewarm: boolean;
  };
  tts: {
    engine: 'piper' | 'kokoro';
    voice: string;
  };
  wakeword: {
    enabled: boolean;
    phrase: string;
    threshold: number;
  };
  llm: {
    // Regular conversational LLM.
    endpoint: string;
    model: string;
  };
  harness: {
    // Agent harness (Claude Code, Codex, …).
    id: string;
    endpoint: string;
    model: string;
  };
  routing: {
    mode: 'auto' | 'llm' | 'harness';
  };
  audio: {
    inputDevice: string;
    outputDevice: string;
  };
  ui: {
    globalShortcut: string;
    theme: 'system' | 'light' | 'dark';
    onboarded: boolean;
  };
  debug: {
    // When true, emit [ARIA_PERF] latency stage marks (see perf.ts). Off by
    // default — zero overhead when disabled. Also force-enableable via ARIA_PERF=1.
    perf: boolean;
  };
}

const defaults: AppConfig = {
  stt: {
    model: DEFAULT_STT_MODEL,
    backend: 'vulkan',
    prewarm: true,
  },
  tts: {
    engine: 'kokoro',
    voice: 'bm_george', // "Jarvis" — refined British male
  },
  wakeword: {
    enabled: true,
    // Bundled openWakeWord models: hey_jarvis, hey_mycroft, alexa.
    // A custom "hey aria" model must be trained and dropped into the
    // wakeword models dir to override this default.
    phrase: 'hey_jarvis',
    // Detection sensitivity (0..1). Lower = more sensitive (fewer misses, more
    // false triggers). 0.4 is a reliable default; the sidecar also relaxes the
    // VAD gate and debounces with a cooldown.
    threshold: 0.4,
  },
  llm: {
    endpoint: '',
    model: '',
  },
  harness: {
    id: '',
    endpoint: '',
    model: '',
  },
  routing: {
    mode: 'auto',
  },
  audio: {
    inputDevice: 'default',
    outputDevice: 'default',
  },
  ui: {
    globalShortcut: 'Super+Shift+A',
    theme: 'system',
    onboarded: false,
  },
  debug: {
    perf: false,
  },
};

export const config = new JsonStore<AppConfig>('aria-config', defaults);
