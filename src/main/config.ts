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
    // The regex router matches nouns, so some sentence shapes are simply
    // unclassifiable by rule (see turn-classifier.ts). 'auto' asks a second
    // opinion on exactly those; 'off' never does. The second opinion is only as
    // useful as it is fast: past this many milliseconds the turn stops waiting
    // and keeps the heuristic answer.
    classifier: 'auto' | 'off';
    classifierTimeoutMs: number;
    // Which second opinion answers. 'builtin' asks the chat model in one short
    // sentence; 'jev' asks TypeSafe's decision model, which returns a typed
    // choice with a calibrated confidence and cannot answer off-schema. Jev
    // falls back to the built-in path when it is unreachable or unsure.
    coordinator: 'builtin' | 'jev';
    jevEndpoint: string;
    jevModel: string;
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
    // Renderer-owned flag: onboarding finished without a working connection.
    'setup-needed': boolean;
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
    classifier: 'auto',
    classifierTimeoutMs: 1500,
    coordinator: 'builtin',
    jevEndpoint: 'https://api.typesafe.ai/v1/systemone',
    jevModel: 'jev-latest',
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
    // Power saver is the fresh-install default because it is the ultra-stable
    // bundle: CPU STT, lightweight Piper TTS, low orb GPU work, and enough spare
    // CPU/GPU headroom that Windows laptops and weaker Linux desktops don't hitch.
    gpuCap: 30,
    perfPreset: 'power-saver',
    'setup-needed': false,
  },
  debug: {
    perf: false,
  },
};

export const config = new JsonStore<AppConfig>('aria-config', defaults);

// ---------------------------------------------------------------------------
// Renderer write validation (CONFIG_SET). The renderer is untrusted input: it
// may only write known LEAF keys (derived from `defaults`), with a value of the
// default's type. Whole subtrees (`remote`, `llm`, …) are never writable.

// Closed string unions: reject values outside the set the code understands.
const ENUMS: Record<string, readonly string[]> = {
  'stt.backend': ['vulkan', 'cpu'],
  'tts.engine': ['piper', 'kokoro'],
  'routing.mode': ['auto', 'llm', 'harness'],
  'routing.classifier': ['auto', 'off'],
  'routing.coordinator': ['builtin', 'jev'],
  'remote.target': ['harness', 'llm', 'custom'],
  'ui.theme': ['midnight', 'nord', 'solarized', 'synthwave', 'forest', 'light'],
  'ui.perfPreset': ['auto', 'power-saver', 'balanced', 'max-performance', 'custom'],
};

// Inclusive numeric bounds (and integer-ness) for leaves where an out-of-range
// value would break a consumer (ports, gain, rate).
const RANGES: Record<string, { min: number; max: number; int?: boolean }> = {
  'tts.speed': { min: 0.25, max: 4 },
  'wakeword.threshold': { min: 0, max: 1 },
  'remote.sshPort': { min: 1, max: 65535, int: true },
  'remote.remotePort': { min: 1, max: 65535, int: true },
  'remote.localPort': { min: 0, max: 65535, int: true },
  'audio.volume': { min: 0, max: 1 },
  'ui.gpuCap': { min: 1, max: 100 },
};

type LeafKind = 'string' | 'number' | 'boolean' | 'nullable-string' | 'array' | 'object';

function leafKinds(): Map<string, LeafKind> {
  const out = new Map<string, LeafKind>();
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const key = prefix ? `${prefix}.${k}` : k;
      if (v === null || v === undefined) out.set(key, 'nullable-string');
      else if (Array.isArray(v)) out.set(key, 'array');
      else if (typeof v === 'object') walk(v as Record<string, unknown>, key);
      else out.set(key, typeof v as LeafKind);
    }
  };
  walk(defaults as unknown as Record<string, unknown>, '');
  return out;
}
const LEAVES = leafKinds();

export type ConfigSetValidation = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Validate a renderer-originated CONFIG_SET. `opts.rejectRawCommand` refuses a
 * non-empty `remote.rawCommand` (an arbitrary argv ARIA will spawn). NOTE: the
 * Settings UI currently writes `remote.rawCommand` from a text field, so the
 * default keeps accepting it as a plain string; flip the option once the UI no
 * longer offers that field.
 */
export function validateConfigSet(
  key: string,
  value: unknown,
  opts: { rejectRawCommand?: boolean } = {},
): ConfigSetValidation {
  if (typeof key !== 'string' || !LEAVES.has(key)) {
    return { ok: false, error: `Unknown or non-writable config key: ${String(key)}` };
  }
  const kind = LEAVES.get(key)!;
  switch (kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `${key} must be a finite number` };
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return { ok: false, error: `${key} must be a boolean` };
      break;
    case 'string':
      if (typeof value !== 'string') return { ok: false, error: `${key} must be a string` };
      break;
    case 'nullable-string':
      if (value !== null && typeof value !== 'string') return { ok: false, error: `${key} must be a string or null` };
      break;
    case 'array':
      if (!Array.isArray(value)) return { ok: false, error: `${key} must be an array` };
      break;
    default:
      return { ok: false, error: `${key} is not writable` };
  }
  const allowed = ENUMS[key];
  if (allowed && !allowed.includes(value as string)) {
    return { ok: false, error: `${key} must be one of: ${allowed.join(', ')}` };
  }
  const range = RANGES[key];
  if (range && typeof value === 'number') {
    if (value < range.min || value > range.max || (range.int && !Number.isInteger(value))) {
      return { ok: false, error: `${key} must be ${range.int ? 'an integer ' : ''}between ${range.min} and ${range.max}` };
    }
  }
  if (typeof value === 'string' && value.length > 4096) {
    return { ok: false, error: `${key} is too long` };
  }
  if (key === 'remote.rawCommand' && opts.rejectRawCommand && typeof value === 'string' && value.trim()) {
    return { ok: false, error: 'remote.rawCommand cannot be set from the renderer' };
  }
  return { ok: true, value };
}
