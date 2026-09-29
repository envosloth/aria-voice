import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

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
  'tiny.en': { size: '39M', description: 'Fastest, English-only (low-end / max responsiveness)' },
  'base.en': { size: '74M', description: 'Fast, English-only (recommended)' },
  'small.en-q5_1': { size: '244M, quantized', description: 'English-only, lower memory (190 MB)' },
  'small.en': { size: '244M', description: 'English-only, full precision (488 MB)' },
  'small': { size: '244M', description: 'Balanced accuracy/speed' },
  'medium': { size: '769M', description: 'Higher accuracy, slower' },
} as const;

// Default STT model. base.en is ~2.2x faster to transcribe than `small` on the
// Vulkan GPU path (~370ms vs ~810ms for a short utterance, measured on the
// RX 9060 XT) with equivalent accuracy on common English voice commands — it
// degrades only on rare foreign proper nouns, where `small`/`medium` (opt-in via
// Settings) do better. Latency on the voice path (mission target ≤500ms) wins for
// the default; accuracy-sensitive users can switch up.
export const DEFAULT_STT_MODEL = 'base.en' as const;

export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_CHANNELS = 1;
export const VAD_FRAME_MS = 80;

// --- Renderer IPC input policy -------------------------------------------------
// Pure (Electron-free) so scripts/smoke-ipc-hardening.js can exercise them
// directly. The renderer is sandboxed but still untrusted input: every payload
// crossing ipcMain is shape-checked and bounded before it reaches privileged code.

/** Secure-store keys the renderer may read/write/delete (see app.js settings + onboarding). */
export const RENDERER_SECRET_KEYS: readonly string[] = ['llm-api-key', 'harness-api-key', 'jev-api-key', 'stt-api-key'];
export function isRendererSecretKey(key: unknown): key is string {
  return typeof key === 'string' && RENDERER_SECRET_KEYS.includes(key);
}

export const LLM_MESSAGE_MAX_CHARS = 32 * 1024;
// Screen frames are 768px JPEG @ q0.45 (app.js), normally ~40-150 KB of base64.
export const LLM_IMAGE_MAX_CHARS = 4 * 1024 * 1024;
export const LLM_TURN_ID_MAX_CHARS = 128;

export interface LlmSendRequest {
  message: string;
  image: string | null;
  turnId: string;
  generationId: number;
  /** Text files the user dropped on the composer for this one message. */
  files: { name: string; text: string }[];
}

export const LLM_MAX_FILES = 3;
export const LLM_FILE_MAX_CHARS = 20000;
export const LLM_FILE_NAME_MAX_CHARS = 200;

/** Returns a normalized request, or null when the payload must be dropped. */
export function parseLlmSendPayload(payload: unknown): LlmSendRequest | null {
  return validateLlmSendPayload(payload).request;
}

/**
 * Like parseLlmSendPayload, but on rejection also returns a user-facing reason
 * and — when the payload still carries a usable turnId — its correlation IDs,
 * so main can settle the renderer's pending turn with LLM_ERROR instead of
 * leaving it in 'processing' forever.
 */
export function validateLlmSendPayload(payload: unknown): {
  request: LlmSendRequest | null;
  error?: string;
  correlation?: { turnId: string; generationId: number };
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { request: null, error: 'Invalid request' };
  const p = payload as Record<string, unknown>;
  const { message, image, turnId, generationId, files } = p;
  const gen = Number(generationId);
  const correlation = typeof turnId === 'string' && turnId && turnId.length <= LLM_TURN_ID_MAX_CHARS
    ? { turnId, generationId: Number.isFinite(gen) && gen > 0 ? gen : Date.now() }
    : undefined;
  const reject = (error: string) => ({ request: null, error, correlation });
  if (!correlation) return reject('Invalid request');
  if (typeof message !== 'string' || !message.trim()) return reject('Empty or invalid message');
  if (message.length > LLM_MESSAGE_MAX_CHARS) {
    return reject(`Message too long (max ${LLM_MESSAGE_MAX_CHARS} characters)`);
  }
  let img: string | null = null;
  if (image !== null && image !== undefined && image !== '') {
    if (typeof image !== 'string' || image.length > LLM_IMAGE_MAX_CHARS) return reject('Screen image too large or invalid');
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) return reject('Screen image too large or invalid');
    img = image;
  }
  const outFiles: { name: string; text: string }[] = [];
  if (files !== undefined && files !== null) {
    if (!Array.isArray(files) || files.length > LLM_MAX_FILES) return reject(`Attach at most ${LLM_MAX_FILES} files`);
    for (const f of files) {
      const rec = f as Record<string, unknown>;
      if (!rec || typeof rec.name !== 'string' || typeof rec.text !== 'string' || !rec.name.trim()
          || rec.name.length > LLM_FILE_NAME_MAX_CHARS || rec.text.length > LLM_FILE_MAX_CHARS) {
        return reject(`Attached file invalid or larger than ${LLM_FILE_MAX_CHARS} characters`);
      }
      outFiles.push({ name: rec.name.replace(/[\r\n"]/g, ' ').trim(), text: rec.text });
    }
  }
  return { request: { message, image: img, ...correlation, files: outFiles } };
}

/**
 * True when `url` is the app's own renderer document: a file: URL (no host)
 * whose path resolves to exactly `expectedPath` (the file passed to loadFile).
 * Query/hash are ignored; everything else — other files, http(s), data:,
 * devtools:, about:blank — is untrusted.
 */
export function isTrustedRendererUrl(url: unknown, expectedPath: string): boolean {
  if (typeof url !== 'string' || !expectedPath) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
  parsed.search = '';
  parsed.hash = '';
  let file: string;
  try { file = fileURLToPath(parsed); } catch { return false; }
  return path.resolve(file) === path.resolve(expectedPath);
}
