import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';

export interface ModelSpec {
  id: string;
  kind: 'stt' | 'tts';
  file: string;
  url: string;
  sizeBytes?: number;   // expected size, for progress when server omits content-length
  sha256?: string;      // optional integrity check
  required: boolean;    // whether it's needed for the configured defaults
}

export interface ModelProgress {
  id: string;
  file: string;
  received: number;
  total: number;
  percent: number;
}

export type ProgressCallback = (p: ModelProgress) => void;

export interface DownloadOptions {
  requestTimeoutMs?: number;
  responseTimeoutMs?: number;
  overallTimeoutMs?: number;
  maxRedirects?: number;
}

const WHISPER_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const PIPER_REVISION = 'e21c7de8d4eab79b902f0d61e662b3f21664b8d2';
const HF_WHISPER = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_REVISION}`;
const HF_PIPER = `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_REVISION}`;
const KOKORO_BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';

const WHISPER_MODELS: Record<string, { sizeBytes: number; sha256: string }> = {
  'tiny.en': { sizeBytes: 77_704_715, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f' },
  'base.en': { sizeBytes: 147_964_211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
  small: { sizeBytes: 487_601_967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
  medium: { sizeBytes: 1_533_763_059, sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208' },
};

const PIPER_MODELS: Record<string, {
  model: { sizeBytes: number; sha256: string };
  config: { sizeBytes: number; sha256: string };
}> = {
  'en_GB-alan-medium': {
    model: { sizeBytes: 63_201_294, sha256: '0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330' },
    config: { sizeBytes: 4_888, sha256: 'c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e' },
  },
  'en_US-lessac-medium': {
    model: { sizeBytes: 63_201_294, sha256: '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f' },
    config: { sizeBytes: 4_885, sha256: 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0' },
  },
};

const KOKORO_MODEL = {
  sizeBytes: 325_532_387,
  sha256: '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5',
};
const KOKORO_VOICES = {
  sizeBytes: 28_214_398,
  sha256: 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
};

// Resolve a Piper voice id (e.g. 'en_US-ryan-high') to its HuggingFace directory.
// piper-voices is laid out as <group>/<lang>/<speaker>/<quality>/, e.g.
// en/en_US/ryan/high/. The id is <lang>-<speaker>-<quality>; the speaker may
// itself contain hyphens, so peel lang off the front and quality off the back.
function piperVoiceBase(voice: string): string {
  const parts = voice.split('-');
  const lang = parts[0];                         // en_US
  const quality = parts[parts.length - 1];       // high
  const speaker = parts.slice(1, -1).join('-');  // ryan
  const group = lang.split('_')[0];              // en
  return `${HF_PIPER}/${group}/${lang}/${speaker}/${quality}`;
}

export const MODELS_DIR =
  process.env.ARIA_MODELS_DIR || path.join(os.homedir(), '.local', 'share', 'aria', 'models');

// Make the effective models dir visible to spawned sidecars (the STT sidecar's
// model lookup reads ARIA_MODELS_DIR) — including when we fell back to the
// default above, so the two never disagree on any OS.
process.env.ARIA_MODELS_DIR = MODELS_DIR;

/**
 * Build the manifest of models needed for the given STT model + TTS engine/voice.
 * Kokoro (default) ships one shared model + a voices pack covering every voice;
 * Piper ships a separate .onnx per voice.
 */
export function buildManifest(sttModel: string, ttsVoice: string, ttsEngine = 'kokoro'): ModelSpec[] {
  const sttMetadata = WHISPER_MODELS[sttModel];
  if (!sttMetadata) throw new Error(`Unsupported STT model: ${sttModel}`);
  const stt: ModelSpec = {
    id: `stt:${sttModel}`,
    kind: 'stt',
    file: `ggml-${sttModel}.bin`,
    url: `${HF_WHISPER}/ggml-${sttModel}.bin`,
    ...sttMetadata,
    required: true,
  };

  if (ttsEngine === 'kokoro') {
    return [
      stt,
      { id: 'tts:kokoro:model', kind: 'tts', file: 'kokoro-v1.0.onnx', url: `${KOKORO_BASE}/kokoro-v1.0.onnx`, ...KOKORO_MODEL, required: true },
      { id: 'tts:kokoro:voices', kind: 'tts', file: 'voices-v1.0.bin', url: `${KOKORO_BASE}/voices-v1.0.bin`, ...KOKORO_VOICES, required: true },
    ];
  }

  // Piper fallback engine. Each voice ships a separate .onnx (+ .onnx.json) under
  // its own per-voice HuggingFace directory (see piperVoiceBase).
  const piperMetadata = PIPER_MODELS[ttsVoice];
  if (!piperMetadata) throw new Error(`Unsupported Piper voice: ${ttsVoice}`);
  const piperBase = piperVoiceBase(ttsVoice);
  return [
    stt,
    { id: `tts:${ttsVoice}`, kind: 'tts', file: `${ttsVoice}.onnx`, url: `${piperBase}/${ttsVoice}.onnx`, ...piperMetadata.model, required: true },
    { id: `tts:${ttsVoice}:config`, kind: 'tts', file: `${ttsVoice}.onnx.json`, url: `${piperBase}/${ttsVoice}.onnx.json`, ...piperMetadata.config, required: true },
  ];
}

export function isPresent(spec: ModelSpec): boolean {
  const dest = path.join(MODELS_DIR, spec.file);
  if (!fs.existsSync(dest)) return false;
  const size = fs.statSync(dest).size;
  if (spec.sizeBytes != null && size !== spec.sizeBytes) return false;
  // A zero-byte or tiny .bin is a failed download — treat as absent when no
  // exact expected size is available.
  if (spec.file.endsWith('.bin') && size < 1024) return false;
  return true;
}

export function missingModels(manifest: ModelSpec[]): ModelSpec[] {
  return manifest.filter((m) => m.required && !isPresent(m));
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 30 * 60_000;
const MAX_REDIRECTS = 5;

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function expectedSize(spec: ModelSpec): number | null {
  if (spec.sizeBytes == null) return null;
  if (!Number.isSafeInteger(spec.sizeBytes) || spec.sizeBytes < 0) {
    throw new Error(`Invalid expected size metadata for ${spec.id}`);
  }
  return spec.sizeBytes;
}

function contentLength(headers: http.IncomingHttpHeaders): number {
  const raw = headers['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Response did not provide a valid Content-Length');
  return parsed;
}

function rangeTotal(headers: http.IncomingHttpHeaders): number | null {
  const raw = headers['content-range'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = typeof value === 'string' ? /^bytes \*\/(\d+)$/.exec(value.trim()) : null;
  return match ? Number(match[1]) : null;
}

function responsePlan(res: http.IncomingMessage, startByte: number, spec: ModelSpec): { append: boolean; total: number } {
  const expected = expectedSize(spec);
  const length = contentLength(res.headers);
  if (res.statusCode === 206) {
    const raw = res.headers['content-range'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const match = typeof value === 'string' ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.trim()) : null;
    if (!match) throw new Error(`Download ${spec.id} returned 206 without a valid Content-Range`);
    const rangeStart = Number(match[1]);
    const rangeEnd = Number(match[2]);
    const total = Number(match[3]);
    if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd) || !Number.isSafeInteger(total) ||
      rangeStart !== startByte || rangeEnd < rangeStart || rangeEnd - rangeStart + 1 !== length || total !== rangeEnd + 1) {
      throw new Error(`Download ${spec.id} returned an invalid partial range`);
    }
    if (expected != null && total !== expected) throw new Error(`Download ${spec.id} size mismatch: expected ${expected}, got ${total}`);
    return { append: true, total };
  }
  // A server may ignore Range and return 200. Restart from byte zero rather
  // than appending duplicate bytes to the existing partial.
  if (expected != null && length !== expected) throw new Error(`Download ${spec.id} size mismatch: expected ${expected}, got ${length}`);
  return { append: false, total: length };
}

async function verifyFile(filePath: string, spec: ModelSpec, exactSize: number): Promise<void> {
  const actualSize = fs.statSync(filePath).size;
  if (actualSize !== exactSize) {
    throw new Error(`Download ${spec.id} size mismatch: expected ${exactSize}, got ${actualSize}`);
  }
  const expected = expectedSize(spec);
  if (expected != null && actualSize !== expected) {
    throw new Error(`Download ${spec.id} size mismatch: expected ${expected}, got ${actualSize}`);
  }
  if (spec.sha256) {
    const wanted = spec.sha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(wanted)) {
      throw new Error(`Checksum mismatch for ${spec.id}: manifest SHA-256 is invalid`);
    }
    const actual = await sha256File(filePath);
    if (actual !== wanted) throw new Error(`Checksum mismatch for ${spec.id}: expected ${wanted}, got ${actual}`);
  }
}

async function existingFileMatches(spec: ModelSpec): Promise<boolean> {
  if (!isPresent(spec)) return false;
  const dest = path.join(MODELS_DIR, spec.file);
  try {
    const size = fs.statSync(dest).size;
    await verifyFile(dest, spec, spec.sizeBytes ?? size);
    return true;
  } catch {
    return false;
  }
}

/** Required models that are absent, wrong-sized, or fail their pinned digest. */
export async function missingOrInvalidModels(manifest: ModelSpec[]): Promise<ModelSpec[]> {
  const missing: ModelSpec[] = [];
  for (const spec of manifest) {
    if (spec.required && !await existingFileMatches(spec)) missing.push(spec);
  }
  return missing;
}

function drain(res: http.IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    res.once('end', resolve);
    res.once('error', reject);
    res.once('aborted', () => reject(new Error('Response aborted while draining')));
    res.resume();
  });
}

/**
 * Download a single model with HTTP Range resume support and progress callbacks.
 * Resumes from a .partial file if one exists. Promotion is fail-closed: exact
 * response size and any supplied SHA-256 must verify before rename.
 */
export async function downloadModel(spec: ModelSpec, onProgress?: ProgressCallback, options: DownloadOptions = {}): Promise<void> {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const dest = path.join(MODELS_DIR, spec.file);
  const partial = dest + '.partial';
  if (await existingFileMatches(spec)) return;
  // Windows rename does not replace an existing destination. Remove only after
  // verification has proved the old file invalid; the partial remains resumable.
  try { fs.rmSync(dest, { force: true }); } catch { /* download will report any later write failure */ }
  const requestTimeoutMs = positiveLimit(options.requestTimeoutMs, REQUEST_TIMEOUT_MS);
  const responseTimeoutMs = positiveLimit(options.responseTimeoutMs, RESPONSE_TIMEOUT_MS);
  const overallTimeoutMs = positiveLimit(options.overallTimeoutMs, OVERALL_TIMEOUT_MS);
  const maxRedirects = Math.max(0, Math.floor(options.maxRedirects ?? MAX_REDIRECTS));
  const deadlineAt = Date.now() + overallTimeoutMs;
  let activeRequest: http.ClientRequest | null = null;
  let activeResponse: http.IncomingMessage | null = null;
  let activeOutput: fs.WriteStream | null = null;
  let deadlineError: Error | null = null;
  const deadline = setTimeout(() => {
    deadlineError = new Error(`Download ${spec.id} exceeded its overall timeout`);
    try { activeRequest?.destroy(deadlineError); } catch { /* ignore */ }
    try { activeResponse?.destroy(deadlineError); } catch { /* ignore */ }
    try { activeOutput?.destroy(deadlineError); } catch { /* ignore */ }
  }, overallTimeoutMs);

  const remaining = () => {
    const ms = deadlineAt - Date.now();
    if (ms <= 0) throw new Error(`Download ${spec.id} exceeded its overall timeout`);
    return ms;
  };
  const responseFor = async (url: URL, headers: Record<string, string>): Promise<http.IncomingMessage> => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Download ${spec.id} uses an unsupported URL protocol`);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(deadlineError || error);
      };
      const timeout = Math.min(requestTimeoutMs, remaining());
      const request = transport.get({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers,
      }, (res) => {
        if (settled) { res.destroy(); return; }
        settled = true;
        activeResponse = res;
        res.setTimeout(Math.min(responseTimeoutMs, remaining()), () => {
          res.destroy(new Error(`Download ${spec.id} response timed out`));
        });
        resolve(res);
      });
      activeRequest = request;
      request.setTimeout(timeout, () => request.destroy(new Error(`Download ${spec.id} request timed out`)));
      request.once('error', (error) => fail(new Error(`Download ${spec.id} connection failed: ${error.message}`)));
    });
  };

  const downloadFrom = async (url: URL, redirects: number): Promise<void> => {
    const startByte = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    const headers: Record<string, string> = startByte > 0 ? { Range: `bytes=${startByte}-` } : {};
    const res = await responseFor(url, headers);
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400) {
      const location = res.headers.location;
      await drain(res);
      if (!location) throw new Error(`Download ${spec.id} redirect was missing a Location header`);
      if (redirects >= maxRedirects) throw new Error(`Download ${spec.id} exceeded the ${maxRedirects}-redirect limit`);
      return downloadFrom(new URL(location, url), redirects + 1);
    }
    if (status === 416) {
      await drain(res);
      const total = rangeTotal(res.headers);
      if (startByte <= 0 || total == null || startByte !== total) {
        try { fs.unlinkSync(partial); } catch { /* next attempt already starts clean */ }
        throw new Error(`Download ${spec.id} received HTTP 416 for an incomplete partial file`);
      }
      try {
        await verifyFile(partial, spec, total);
      } catch (error) {
        try { fs.rmSync(partial, { force: true }); } catch { /* ignore */ }
        throw error;
      }
      fs.renameSync(partial, dest);
      onProgress?.({ id: spec.id, file: spec.file, received: total, total, percent: 100 });
      return;
    }
    if (status < 200 || status >= 300) {
      await drain(res);
      throw new Error(`Download ${spec.id} failed: HTTP ${status}`);
    }

    let plan: { append: boolean; total: number };
    try {
      plan = responsePlan(res, startByte, spec);
    } catch (error) {
      try { await drain(res); } catch { /* original validation error is more useful */ }
      throw error;
    }
    const initial = plan.append ? startByte : 0;
    let received = initial;
    const out = fs.createWriteStream(partial, { flags: plan.append ? 'a' : 'w' });
    activeOutput = out;
    res.on('data', (chunk: Buffer) => {
      received += chunk.length;
      onProgress?.({
        id: spec.id,
        file: spec.file,
        received,
        total: plan.total,
        percent: Math.min(100, Math.round((received / plan.total) * 100)),
      });
    });
    await pipeline(res, out);
    activeOutput = null;
    if (received !== plan.total) throw new Error(`Download ${spec.id} size mismatch: expected ${plan.total}, got ${received}`);
    try {
      await verifyFile(partial, spec, plan.total);
    } catch (error) {
      try { fs.rmSync(partial, { force: true }); } catch { /* ignore */ }
      throw error;
    }
    fs.renameSync(partial, dest);
    onProgress?.({ id: spec.id, file: spec.file, received: plan.total, total: plan.total, percent: 100 });
  };

  try {
    let initialUrl: URL;
    try { initialUrl = new URL(spec.url); } catch { throw new Error(`Download ${spec.id} has an invalid URL`); }
    await downloadFrom(initialUrl, 0);
  } catch (error) {
    throw deadlineError || error;
  } finally {
    clearTimeout(deadline);
  }
}

/** Download all missing required models sequentially, reporting per-file progress. */
export async function ensureModels(
  manifest: ModelSpec[],
  onProgress?: ProgressCallback,
): Promise<{ downloaded: string[]; skipped: string[] }> {
  const downloaded: string[] = [];
  const skipped: string[] = [];

  for (const spec of manifest) {
    if (!spec.required) continue;
    if (await existingFileMatches(spec)) {
      skipped.push(spec.id);
      continue;
    }
    // A destination that failed a metadata check must not be mistaken for a
    // future successful download. Preserve only .partial files for resumability.
    try { fs.rmSync(path.join(MODELS_DIR, spec.file), { force: true }); } catch { /* ignore */ }
    await downloadModel(spec, onProgress);
    downloaded.push(spec.id);
  }

  return { downloaded, skipped };
}
