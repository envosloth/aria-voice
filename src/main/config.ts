import { JsonStore } from './json-store';
import { DEFAULT_STT_MODEL } from '../shared/constants';

interface AppConfig {
  stt: {
    model: string;
    backend: 'vulkan' | 'cpu';
  };
  tts: {
    engine: 'piper' | 'kokoro';
    voice: string;
  };
  wakeword: {
    enabled: boolean;
    phrase: string;
  };
  llm: {
    endpoint: string;
    model: string;
  };
  audio: {
    inputDevice: string;
    outputDevice: string;
  };
  ui: {
    globalShortcut: string;
    theme: 'system' | 'light' | 'dark';
  };
}

const defaults: AppConfig = {
  stt: {
    model: DEFAULT_STT_MODEL,
    backend: 'vulkan',
  },
  tts: {
    engine: 'piper',
    voice: 'en_US-lessac-medium',
  },
  wakeword: {
    enabled: true,
    // Bundled openWakeWord models: hey_jarvis, hey_mycroft, alexa.
    // A custom "hey aria" model must be trained and dropped into the
    // wakeword models dir to override this default.
    phrase: 'hey_jarvis',
  },
  llm: {
    endpoint: '',
    model: '',
  },
  audio: {
    inputDevice: 'default',
    outputDevice: 'default',
  },
  ui: {
    globalShortcut: 'Super+Shift+A',
    theme: 'system',
  },
};

export const config = new JsonStore<AppConfig>('aria-config', defaults);
