import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import crypto from 'crypto';

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

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const HF_PIPER = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const KOKORO_BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';

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

/**
 * Build the manifest of models needed for the given STT model + TTS engine/voice.
 * Kokoro (default) ships one shared model + a voices pack covering every voice;
 * Piper ships a separate .onnx per voice.
 */
export function buildManifest(sttModel: string, ttsVoice: string, ttsEngine = 'kokoro'): ModelSpec[] {
  const stt: ModelSpec = {
    id: `stt:${sttModel}`,
    kind: 'stt',
    file: `ggml-${sttModel}.bin`,
    url: `${HF_WHISPER}/ggml-${sttModel}.bin`,
    required: true,
  };

  if (ttsEngine === 'kokoro') {
    return [
      stt,
      { id: 'tts:kokoro:model', kind: 'tts', file: 'kokoro-v1.0.onnx', url: `${KOKORO_BASE}/kokoro-v1.0.onnx`, required: true },
      { id: 'tts:kokoro:voices', kind: 'tts', file: 'voices-v1.0.bin', url: `${KOKORO_BASE}/voices-v1.0.bin`, required: true },
    ];
  }

  // Piper fallback engine. Each voice ships a separate .onnx (+ .onnx.json) under
  // its own per-voice HuggingFace directory (see piperVoiceBase).
  const piperBase = piperVoiceBase(ttsVoice);
  return [
    stt,
    { id: `tts:${ttsVoice}`, kind: 'tts', file: `${ttsVoice}.onnx`, url: `${piperBase}/${ttsVoice}.onnx`, required: true },
    { id: `tts:${ttsVoice}:config`, kind: 'tts', file: `${ttsVoice}.onnx.json`, url: `${piperBase}/${ttsVoice}.onnx.json`, required: true },
  ];
}

export function isPresent(spec: ModelSpec): boolean {
  const dest = path.join(MODELS_DIR, spec.file);
  if (!fs.existsSync(dest)) return false;
  // A zero-byte or tiny .bin is a failed download — treat as absent.
  const size = fs.statSync(dest).size;
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

/**
 * Download a single model with HTTP Range resume support and progress callbacks.
 * Resumes from a .partial file if one exists. Verifies sha256 when provided.
 */
export function downloadModel(spec: ModelSpec, onProgress?: ProgressCallback): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    const dest = path.join(MODELS_DIR, spec.file);
    const partial = dest + '.partial';

    let startByte = 0;
    if (fs.existsSync(partial)) {
      startByte = fs.statSync(partial).size;
    }

    const url = new URL(spec.url);
    const transport = url.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {};
    if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;

    const req = transport.get(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        // Follow redirects (HuggingFace uses them heavily)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const redirected: ModelSpec = { ...spec, url: new URL(res.headers.location, spec.url).toString() };
          downloadModel(redirected, onProgress).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode === 416) {
          // Range not satisfiable — partial is already complete; finalize.
          res.resume();
          fs.renameSync(partial, dest);
          resolve();
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`Download ${spec.id} failed: HTTP ${res.statusCode}`));
          return;
        }

        const isResume = res.statusCode === 206;
        const contentLen = parseInt(res.headers['content-length'] || '0', 10);
        const total = (isResume ? startByte : 0) + contentLen || spec.sizeBytes || 0;

        const out = fs.createWriteStream(partial, { flags: isResume ? 'a' : 'w' });
        let received = isResume ? startByte : 0;

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (onProgress && total > 0) {
            onProgress({
              id: spec.id,
              file: spec.file,
              received,
              total,
              percent: Math.min(100, Math.round((received / total) * 100)),
            });
          }
        });

        res.pipe(out);

        out.on('finish', async () => {
          out.close();
          try {
            if (spec.sha256) {
              const actual = await sha256File(partial);
              if (actual !== spec.sha256) {
                fs.unlinkSync(partial);
                reject(new Error(`Checksum mismatch for ${spec.id}: expected ${spec.sha256}, got ${actual}`));
                return;
              }
            }
            fs.renameSync(partial, dest);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        out.on('error', reject);
      },
    );

    req.on('error', (err) => {
      reject(new Error(`Download ${spec.id} connection failed: ${err.message}`));
    });
  });
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
    if (isPresent(spec)) {
      skipped.push(spec.id);
      continue;
    }
    await downloadModel(spec, onProgress);
    downloaded.push(spec.id);
  }

  return { downloaded, skipped };
}
