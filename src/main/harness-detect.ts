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
import http from 'http';
import os from 'os';
import path from 'path';
import { isLoopbackHostname } from './endpoint-security';

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
  yamlFiles?: string[];     // config.yaml candidates; lowest precedence, api_server block only
  keyVars: string[];        // env var names that may hold the gateway key
  hostVars: string[];
  portVars: string[];
  modelVars: string[];
  enabledVars: string[];    // if present and falsy, the gateway is turned off
  defaultHost: string;
  defaultPort: number;
  chatPath: string;
  minKeyLength?: number;    // the gateway refuses to start with a shorter key
  restartHint?: string;     // shown when a running gateway rejects the on-disk key
  enableHint?: string;      // shown when nothing is configured and nothing is listening
}

// Known local harnesses that publish an OpenAI-compatible gateway. Hermes is
// verified against a real install; OpenClaw is best-effort (common var names)
// and degrades gracefully to "nothing found" if the file/vars don't exist.
const DETECTORS: Record<string, Detector> = {
  hermes: {
    // $HERMES_HOME wins (Hermes' own override), then the default home.
    files: ['$HERMES_HOME/.env', '~/.hermes/.env'],
    yamlFiles: ['$HERMES_HOME/config.yaml', '~/.hermes/config.yaml'],
    keyVars: ['API_SERVER_KEY'],
    hostVars: ['API_SERVER_HOST'],
    portVars: ['API_SERVER_PORT'],
    modelVars: ['API_SERVER_MODEL_NAME'],
    enabledVars: ['API_SERVER_ENABLED'],
    defaultHost: '127.0.0.1',
    defaultPort: 8642,
    chatPath: '/v1/chat/completions',
    minKeyLength: 16,
    restartHint: 'hermes gateway restart',
    enableHint: 'Add API_SERVER_ENABLED=true and API_SERVER_KEY=<16+ chars, e.g. from `openssl rand -hex 32`> to ~/.hermes/.env, then run `hermes gateway restart`.',
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

// '$HERMES_HOME/x' resolves only when that variable is set (Hermes' own override
// for a relocated home); otherwise the candidate is skipped.
function expandHome(p: string): string {
  if (p.startsWith('$HERMES_HOME')) {
    const h = (process.env.HERMES_HOME || '').trim();
    return h ? path.join(expandHome(h), p.slice('$HERMES_HOME'.length)) : '';
  }
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// Read the scalar settings of any `api_server:` block in a Hermes config.yaml
// (gateway.api_server, gateway.platforms.api_server, platforms.api_server — all
// documented spellings) and return them under their API_SERVER_* env names, so
// they merge with .env values. Indent-based on purpose: no YAML dependency, and
// only flat scalars (optionally under `extra:`) are ever needed.
const YAML_API_KEYS: Record<string, string> = {
  key: 'API_SERVER_KEY', host: 'API_SERVER_HOST', port: 'API_SERVER_PORT',
  model_name: 'API_SERVER_MODEL_NAME', enabled: 'API_SERVER_ENABLED',
};
export function parseApiServerYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)api_server\s*:\s*(?:#.*)?$/.exec(lines[i]);
    if (!head) continue;
    const base = head[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if ((/^(\s*)/.exec(line) as RegExpExecArray)[1].length <= base) break;
      const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      const envName = kv && YAML_API_KEYS[kv[1]];
      if (!kv || !envName) continue;
      let val = kv[2].trim();
      const quote = val[0];
      if ((quote === '"' || quote === "'") && val.lastIndexOf(quote) > 0) {
        val = val.slice(1, val.lastIndexOf(quote));
      } else {
        const hash = val.indexOf(' #');
        if (hash >= 0) val = val.slice(0, hash).trim();
      }
      if (val && out[envName] === undefined) out[envName] = val;
    }
  }
  return out;
}

function firstVar(env: Record<string, string>, names: string[]): string | undefined {
  for (const n of names) {
    if (env[n] !== undefined && env[n] !== '') return env[n];
  }
  return undefined;
}

// A gateway's BIND host is not a connect host: 0.0.0.0 / :: (or blank) mean
// "all interfaces", which a client must reach via loopback. IPv6 literals need
// brackets in a URL; building through the URL API keeps the result well-formed.
export function connectHost(bindHost: string | undefined, fallback: string): string {
  let h = (bindHost || '').trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h || h === '0.0.0.0' || h === '::' || h === '0:0:0:0:0:0:0:0' || h === '*') return fallback;
  return h.includes(':') ? `[${h}]` : h;
}

export function buildEndpoint(
  host: string | undefined, port: string | undefined,
  defaultHost: string, defaultPort: number, chatPath: string,
): string {
  const fallbackUrl = `http://${defaultHost}:${defaultPort}${chatPath}`;
  try {
    const url = new URL(fallbackUrl);
    url.hostname = connectHost(host, defaultHost);
    const p = Number(port);
    url.port = Number.isInteger(p) && p > 0 && p <= 65535 ? String(p) : String(defaultPort);
    return url.toString();
  } catch {
    return fallbackUrl;
  }
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
  // Set by detectHarnessLive(): the gateway answered and accepted the key.
  verified?: boolean;
  status?: HarnessStatus;
}

export type HarnessStatus =
  | 'ready'          // listening and the key works
  | 'key-rejected'   // listening, but it refused the key on disk
  | 'running-no-key' // listening, but no key could be found
  | 'not-running'    // key found, nothing listening
  | 'not-enabled'    // nothing configured and nothing listening
  | 'weak-key'       // key too short for the gateway to start
  | 'unverified';    // found, but couldn't be checked (non-loopback host, no probe)

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
  const readFirstWins = (file: string, env: Record<string, string>) => {
    for (const [k, v] of Object.entries(env)) {
      if (merged[k] === undefined || merged[k] === '') { merged[k] = v; keySource[k] = file; }
    }
  };
  for (const raw of det.files) {
    const file = expandHome(raw);
    if (!file) continue;
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    anyFile = anyFile || file;
    readFirstWins(file, parseEnvFile(text));
  }

  // The process environment (ARIA launched from a shell that sourced the
  // harness env) comes next, for every var we care about.
  const allVars = [...det.keyVars, ...det.hostVars, ...det.portVars, ...det.modelVars, ...det.enabledVars];
  for (const n of allVars) {
    const v = process.env[n];
    if (v && (merged[n] === undefined || merged[n] === '')) { merged[n] = v; keySource[n] = 'environment'; }
  }

  // config.yaml is the lowest-precedence source (Hermes documents env > yaml).
  for (const raw of det.yamlFiles || []) {
    const file = expandHome(raw);
    if (!file) continue;
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    anyFile = anyFile || file;
    readFirstWins(file, parseApiServerYaml(text));
  }

  let source = '';
  const apiKey = firstVar(merged, det.keyVars);
  if (apiKey) {
    for (const n of det.keyVars) { if (merged[n] === apiKey) { source = keySource[n]; break; } }
  }

  const host = firstVar(merged, det.hostVars) || det.defaultHost;
  const port = firstVar(merged, det.portVars) || String(det.defaultPort);
  const endpoint = buildEndpoint(host, port, det.defaultHost, det.defaultPort, det.chatPath);
  const model = firstVar(merged, det.modelVars);
  const disabled = det.enabledVars.some((n) => isFalsy(merged[n]));

  if (apiKey && det.minKeyLength && apiKey.trim().length < det.minKeyLength) {
    return {
      found: false, endpoint, model, status: 'weak-key',
      message: `The key in ${prettyPath(source)} is shorter than ${det.minKeyLength} characters, so the ${id === 'hermes' ? 'Hermes' : id} gateway will refuse to start. Use a longer one (e.g. \`openssl rand -hex 32\`).`,
    };
  }

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

// ---------------------------------------------------------------------------
// Live verification. Reading a key off disk proves nothing about whether the
// gateway is up, listening where we think, or still using that key (it only
// re-reads .env on restart). One short loopback probe answers all three.

interface ProbeResult { status: number; body: string }

function probe(url: string, headers: Record<string, string>, timeoutMs: number): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: ProbeResult | null) => { if (!settled) { settled = true; resolve(v); } };
    let req: http.ClientRequest;
    try {
      req = http.get(url, { headers, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { if (body.length < 65536) body += c; });
        res.on('end', () => done({ status: res.statusCode || 0, body }));
        res.on('error', () => done(null));
        res.on('aborted', () => done(null));
      });
    } catch { done(null); return; }
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    // Hard wall-clock cap: a server trickling bytes must not stall onboarding.
    setTimeout(() => { req.destroy(); done(null); }, timeoutMs + 500).unref();
  });
}

function originOf(endpoint: string | undefined): string | null {
  try { const u = new URL(endpoint || ''); return u.protocol === 'http:' ? u.origin : null; } catch { return null; }
}

function isLoopbackOrigin(origin: string): boolean {
  try { return isLoopbackHostname(new URL(origin).hostname); } catch { return false; }
}

export interface LiveDetectOptions {
  timeoutMs?: number;
  // Extra origins to try when the configured one is silent (default: the
  // harness' stock host:port). Tests pass [] for determinism.
  fallbackOrigins?: string[];
}

/**
 * detectHarness() plus a live check: is the gateway listening, and does it
 * accept the key we found? Sets `verified`, a precise `status`, and a message
 * that says what to do next. Never throws.
 */
export async function detectHarnessLive(id: string, opts: LiveDetectOptions = {}): Promise<HarnessDetection> {
  const base = detectHarness(id);
  const det = DETECTORS[id];
  if (!det || base.status === 'weak-key') return base;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const cmdName = id === 'hermes' ? 'Hermes' : id;

  // Where might it be listening? The configured address first, then the stock one.
  const origins: string[] = [];
  for (const o of [originOf(base.endpoint), ...(opts.fallbackOrigins ?? [`http://${det.defaultHost}:${det.defaultPort}`])]) {
    if (o && !origins.includes(o)) origins.push(o);
  }

  let live: string | null = null;
  for (const origin of origins) {
    if (!isLoopbackOrigin(origin)) continue; // never probe (or send a key to) a remote host
    const h = await probe(`${origin}/health`, {}, timeoutMs);
    // Any HTTP answer means a server is there; for Hermes require its own reply
    // so an unrelated app on the port isn't mistaken for the gateway.
    if (!h) continue;
    if (id === 'hermes') {
      let ok = false;
      try { ok = JSON.parse(h.body).status === 'ok'; } catch { /* not hermes */ }
      if (!ok) continue;
    }
    live = origin;
    break;
  }

  const rebuild = (origin: string): string => {
    try { return new URL(det.chatPath, origin).toString(); } catch { return base.endpoint || origin + det.chatPath; }
  };

  if (!live) {
    if (base.found) {
      return {
        ...base, verified: false, status: 'not-running',
        message: `Found the ${cmdName} key in ${prettyPath(base.source || '')}, but nothing is listening at ${originOf(base.endpoint) || `${det.defaultHost}:${det.defaultPort}`}. ` +
          `Start the gateway${det.restartHint ? ` (\`${det.restartHint}\`)` : ''} and try again.`,
      };
    }
    return {
      ...base, verified: false, status: 'not-enabled',
      message: det.enableHint
        ? `${cmdName}'s API server isn't set up yet. ${det.enableHint}`
        : base.message,
    };
  }

  const endpoint = rebuild(live);
  if (!base.apiKey) {
    return {
      ...base, endpoint, verified: false, status: 'running-no-key',
      message: `${cmdName} is running at ${live}, but no API key was found in its config. Paste the key below (API_SERVER_KEY).`,
    };
  }

  const auth = await probe(`${live}/v1/models`, { Authorization: `Bearer ${base.apiKey}` }, timeoutMs);
  if (auth && auth.status === 200) {
    let liveModel: string | undefined;
    try {
      const first = JSON.parse(auth.body)?.data?.[0]?.id;
      if (typeof first === 'string' && first) liveModel = first;
    } catch { /* keep the configured model */ }
    return {
      ...base, endpoint, model: base.model || liveModel, verified: true, status: 'ready',
      message: `Connected to ${cmdName} at ${live} (key from ${prettyPath(base.source || '')}).`,
    };
  }
  if (auth && (auth.status === 401 || auth.status === 403)) {
    return {
      ...base, endpoint, verified: false, status: 'key-rejected',
      message: `${cmdName} is running but rejected the key in ${prettyPath(base.source || '')} — it was probably started before the key changed.` +
        `${det.restartHint ? ` Run \`${det.restartHint}\`, then` : ' Restart it, then'} try again.`,
    };
  }
  return {
    ...base, endpoint, verified: false, status: 'unverified',
    message: `${cmdName} is running at ${live}; couldn't confirm the key (${auth ? `HTTP ${auth.status}` : 'no reply'}).`,
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
