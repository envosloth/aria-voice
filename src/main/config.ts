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
    speed: number; // speaking rate multiplier, 0.5..2.0 (1.0 = normal)
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
  conversation: {
    // After a spoken reply to a voice turn, re-open the mic for a few seconds so
    // the user can keep talking without re-saying the wake word. Off by default.
    enabled: boolean;
  };
  // Remote access to the harness (or any endpoint) over SSH. When
  // `enabled` is true, ARIA spawns `ssh -N -L <localPort>:remoteHost:
  // remotePort user@sshHost` at startup (or on demand), keeps the process
  // alive, and exposes a `tunneledEndpoint` URL the user can paste into
  // the harness/llm endpoint field (typically http://127.0.0.1:localPort/
  // v1/chat/completions). The tunnel state (PID, last error, bytes
  // forwarded) is published to the renderer for a status indicator.
  //
  // Why a separate config block (not a free-form command): SSH tunnels
  // need a single, well-defined schema (host, user, ports, identity file,
  // password) so the Settings UI can build a real form. Power users can
  // still bypass the form by setting `rawCommand` (the full `ssh -N -L
  // …` line), but the structured form is the safe path. The local port
  // defaults to 0 (OS-assigned) so multiple ARIA instances on the same
  // machine don't collide; the actual chosen port is reported back in
  // `tunneledPort` after the tunnel is up.
  remote: {
    enabled: boolean;
    // The shape of the tunnel target: a "harness" tunnel rewrites
    // harness.endpoint on connect, a "llm" tunnel rewrites llm.endpoint,
    // a "custom" tunnel just exposes the local port and lets the user
    // paste the URL anywhere. Default: 'harness' (the common case for
    // ARIA — Claude Code / Codex run on a remote dev box).
    target: 'harness' | 'llm' | 'custom';
    sshHost: string;          // user@hostname or user@ip
    sshPort: number;          // SSH server port (default 22)
    identityFile: string;     // path to private key (default ~/.ssh/id_rsa)
    remoteHost: string;       // host the remote service runs on (usually 127.0.0.1)
    remotePort: number;       // port the remote service listens on
    localPort: number;        // 0 = OS-assigned
    // If non-empty, overrides the structured form. Use with care —
    // arbitrary shell-interpreted strings are a foot-gun, so the
    // renderer should warn before saving.
    rawCommand: string;
    // Auto-reconnect on drop. Default true; the tunnel supervisor
    // restarts with exponential backoff (1s, 2s, 4s, …, capped at 30s).
    autoReconnect: boolean;
  };
  audio: {
    inputDevice: string;
    outputDevice: string;
    volume: number; // TTS output volume, 0.0..1.0 (applied renderer-side)
  };
  ui: {
    globalShortcut: string;
    // Themes from the Glass Observatory UI redesign. 'system'/'dark' are legacy
    // values no longer offered (migrated to 'midnight' on load — see migrateConfig).
    theme: 'midnight' | 'nord' | 'solarized' | 'synthwave' | 'forest' | 'light';
    onboarded: boolean;
    // Cap on ARIA's own GPU work (percent), 20..100. Bounds the orb animation +
    // on-device STT so a spoken reply can't drive the GPU to 100% and freeze the
    // desktop on weaker hardware. See hardware.ts/perfProfile.
    gpuCap: number;
    // Resource-usage preset that drives STT model/backend/threads, TTS engine/
    // voice, orb quality, and gpuCap as one spec-aware bundle. 'auto' optimises
    // for the host; 'custom' = the user changed an individual setting by hand.
    // See hardware.ts/resolveProfile.
    perfPreset: 'auto' | 'power-saver' | 'balanced' | 'max-performance' | 'custom';
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
    speed: 1.0,
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
  conversation: {
    enabled: false,
  },
  remote: {
    enabled: false,
    target: 'harness',
    sshHost: '',
    sshPort: 22,
    identityFile: '',
    remoteHost: '127.0.0.1',
    remotePort: 8642,
    localPort: 0,
    rawCommand: '',
    autoReconnect: true,
  },
  audio: {
    inputDevice: 'default',
    outputDevice: 'default',
    volume: 1.0,
  },
  ui: {
    globalShortcut: 'Ctrl+Shift+A',
    theme: 'midnight',
    onboarded: false,
    gpuCap: 50,
    perfPreset: 'auto',
  },
  debug: {
    perf: false,
  },
};

export const config = new JsonStore<AppConfig>('aria-config', defaults);
