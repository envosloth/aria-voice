// Auto-detect a local harness's connection settings from the config it already
// wrote on disk, so users don't have to hunt for their gateway URL + API key.
//
// A local harness (Hermes, OpenClaw, …) that exposes an OpenAI-compatible
// gateway already records its host/port/key in a dotenv file in its own home
// dir. Hermes, for example, writes API_SERVER_KEY / API_SERVER_HOST /
// API_SERVER_PORT / API_SERVER_MODEL_NAME to ~/.hermes/.env. Rather than make
// the user open that file, copy the key, and paste it into ARIA, we read it for
// them and pre-fill the Settings/onboarding fields.
//
// Pure parsing (parseEnvFile) + a small fs read per candidate file. No Electron
// deps, so it's unit-testable and runs the self-check at the bottom via
// `node harness-detect.js`.

import fs from 'fs';
import os from 'os';
import path from 'path';

// Parse a dotenv-style file into a flat map. Handles `KEY=VALUE`, an optional
// `export ` prefix, surrounding single/double quotes, and skips blank/comment
// lines. Inline `# comment` is only stripped from UNquoted values (a quoted
// value may legitimately contain `#`). Last assignment wins.
// ponytail: no ${VAR} interpolation or multiline values — the harness .env
// files ARIA reads don't use them; add if a real file needs it.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    const quote = val[0];
    if ((quote === '"' || quote === "'") && val.endsWith(quote) && val.length >= 2) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

interface Detector {
  files: string[];          // candidate dotenv paths (~ expanded), merged first-wins
  keyVars: string[];        // env var names that may hold the gateway key
  hostVars: string[];
  portVars: string[];
  modelVars: string[];
  enabledVars: string[];    // if present and falsy, the gateway is turned off
  defaultHost: string;
  defaultPort: number;
  chatPath: string;
}

// Known local harnesses that publish an OpenAI-compatible gateway. Hermes is
// verified against a real install; OpenClaw is best-effort (common var names)
// and degrades gracefully to "nothing found" if the file/vars don't exist.
const DETECTORS: Record<string, Detector> = {
  hermes: {
    files: ['~/.hermes/.env'],
    keyVars: ['API_SERVER_KEY'],
    hostVars: ['API_SERVER_HOST'],
    portVars: ['API_SERVER_PORT'],
    modelVars: ['API_SERVER_MODEL_NAME'],
    enabledVars: ['API_SERVER_ENABLED'],
    defaultHost: '127.0.0.1',
    defaultPort: 8642,
    chatPath: '/v1/chat/completions',
  },
  openclaw: {
    files: ['~/.openclaw/.env', '~/.config/openclaw/.env', '~/.openclaw/config.env'],
    keyVars: ['OPENCLAW_API_KEY', 'OPENCLAW_KEY', 'API_SERVER_KEY', 'API_KEY'],
    hostVars: ['OPENCLAW_HOST', 'API_SERVER_HOST', 'HOST'],
    portVars: ['OPENCLAW_PORT', 'API_SERVER_PORT', 'PORT'],
    modelVars: ['OPENCLAW_MODEL', 'API_SERVER_MODEL_NAME', 'MODEL'],
    enabledVars: ['OPENCLAW_API_SERVER_ENABLED', 'API_SERVER_ENABLED'],
    defaultHost: '127.0.0.1',
    defaultPort: 3000,
    chatPath: '/v1/chat/completions',
  },
};

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function firstVar(env: Record<string, string>, names: string[]): string | undefined {
  for (const n of names) {
    if (env[n] !== undefined && env[n] !== '') return env[n];
  }
  return undefined;
}

function isFalsy(v: string | undefined): boolean {
  if (v === undefined) return false;
  return /^(false|0|no|off)$/i.test(v.trim());
}

export interface HarnessDetection {
  found: boolean;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  source?: string;   // the file (or 'environment') the key came from
  message: string;   // human-readable, shown in the UI
}

/**
 * Read a harness's own config files and pull out its gateway endpoint, model,
 * and API key. Never throws. `found` is true only when a key was located —
 * that's the thing the user can't easily find themselves.
 */
export function detectHarness(id: string): HarnessDetection {
  const det = DETECTORS[id];
  if (!det) {
    return { found: false, message: `No local auto-detect for "${id}". Enter the endpoint and key manually.` };
  }

  // Merge readable candidate files (earlier files win per-var), tracking which
  // file each key came from for the status line.
  const merged: Record<string, string> = {};
  const keySource: Record<string, string> = {};
  let anyFile = '';
  for (const raw of det.files) {
    const file = expandHome(raw);
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    anyFile = anyFile || file;
    const env = parseEnvFile(text);
    for (const [k, v] of Object.entries(env)) {
      if (merged[k] === undefined) { merged[k] = v; keySource[k] = file; }
    }
  }

  // Fall back to the process environment (ARIA launched from a shell that
  // sourced the harness env) for the key vars only.
  let source = '';
  let apiKey = firstVar(merged, det.keyVars);
  if (apiKey) {
    for (const n of det.keyVars) { if (merged[n] === apiKey) { source = keySource[n]; break; } }
  } else {
    for (const n of det.keyVars) {
      if (process.env[n]) { apiKey = process.env[n]; source = 'environment'; break; }
    }
  }

  const host = firstVar(merged, det.hostVars) || det.defaultHost;
  const port = firstVar(merged, det.portVars) || String(det.defaultPort);
  const endpoint = `http://${host}:${port}${det.chatPath}`;
  const model = firstVar(merged, det.modelVars);
  const disabled = det.enabledVars.some((n) => isFalsy(merged[n]));

  if (!apiKey) {
    const where = anyFile ? `Checked ${prettyPath(anyFile)}` : `No ${id} config found in ${det.files.map(prettyPath).join(', ')}`;
    return {
      found: false,
      endpoint,
      model,
      message: `${where} — no API key there. The endpoint was filled in; add the key manually if the gateway needs one.`,
    };
  }

  const disabledNote = disabled ? ' (heads up: its gateway looks disabled — start it before talking to ARIA)' : '';
  return {
    found: true,
    endpoint,
    model,
    apiKey,
    source,
    message: `Found ${id === 'hermes' ? 'Hermes gateway' : id} key in ${prettyPath(source)}${disabledNote}.`,
  };
}

// Collapse the home dir back to ~ for a friendlier status line.
function prettyPath(p: string): string {
  if (p === 'environment') return 'your shell environment';
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// Self-check: `node dist/main/harness-detect.js` (or ts-node). Verifies the
// dotenv parser against the real shapes Hermes writes.
if (require.main === module) {
  const assert = require('assert');
  const env = parseEnvFile([
    '# comment',
    'export API_SERVER_ENABLED=true',
    'API_SERVER_PORT=8642   # inline comment',
    'API_SERVER_HOST=127.0.0.1',
    'API_SERVER_KEY="desk-quoted-key#notcomment"',
    "API_SERVER_MODEL_NAME='Hermes Agent'",
    'BLANK=',
    'noequalsline',
  ].join('\n'));
  assert.strictEqual(env.API_SERVER_PORT, '8642');
  assert.strictEqual(env.API_SERVER_KEY, 'desk-quoted-key#notcomment');
  assert.strictEqual(env.API_SERVER_MODEL_NAME, 'Hermes Agent');
  assert.strictEqual(env.API_SERVER_ENABLED, 'true');
  assert.strictEqual(env.BLANK, '');
  assert.strictEqual(isFalsy('false'), true);
  assert.strictEqual(isFalsy('true'), false);
  // eslint-disable-next-line no-console
  console.log('harness-detect self-check OK');
}
