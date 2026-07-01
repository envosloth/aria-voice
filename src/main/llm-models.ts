// Model auto-discovery for OpenAI-compatible endpoints (Hermes, Ollama, LM
// Studio, vLLM, etc.). Calls GET {endpoint}/v1/models, parses the standard
// `data[].id` list, and returns the recommended default + the full list.
//
// Exported separately from llm-stream.ts (which is the streaming chat client)
// so the dependency surface stays narrow — this only needs `https`/`http` +
// URL parsing. Pure (no Electron), so it's unit-testable.
//
// The discovery request is short-lived (8s timeout) and never streams. A
// missing, rejected, or offline endpoint returns ok:false with a clear error so
// the Settings UI can fall back to manual entry instead of silently giving up.

import http from 'http';
import https from 'https';
import { URL } from 'url';

// Same wiring as llm-stream.ts: shared keep-alive agent pool so repeated
// discovery probes across navigations in Settings don't handshake each time.
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 4 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 4 });

// Pure: convert any chat-endpoint URL shape (full chat-completions URL, .../v1
// base, or host only) to the /v1/models route. Mirrors the normalization in
// llm-stream.ts so the user can paste the same URL for both chat + discovery.
export function normalizeChatBaseUrl(rawEndpoint: string): URL | null {
  if (!rawEndpoint) return null;
  let url: URL;
  try {
    url = new URL(rawEndpoint);
  } catch {
    return null;
  }
  const base = url.pathname.replace(/\/+$/, '');
  if (base === '') {
    url.pathname = '/v1/models';                       // host only
  } else if (/\/models$/.test(base)) {
    url.pathname = base;                               // already the models route — don't double-append
  } else if (/\/v\d+$/.test(base)) {
    url.pathname = base + '/models';                   // "…/v1" base
  } else if (/\/chat\/?completions$/.test(base)) {
    // trim /chat/completions so "http://host/v1/chat/completions" -> /v1/models
    url.pathname = base.replace(/\/chat\/?completions$/, '') + '/models';
  } else {
    url.pathname = base + '/models';                   // unknown shape — best-effort
  }
  return url;
}

export interface DiscoveredModel {
  id: string;
}

export interface DiscoverResult {
  ok: boolean;
  endpoint: string;        // the resolved GET URL (echoed for the UI to show)
  models: string[];        // sorted list of model ids (may be empty on failure)
  recommended?: string;    // best default to pre-fill the model field
  error?: string;          // human-readable error when ok:false
}

// Pure: choose the recommended default from a list of model ids.
// Heuristic — keep alphabetical-first among common/default-sounding names so the
// picker shows something sensible without the user sorting. Stays opaque on a
// degenerate response (one-element list, no usable strings).
export function pickRecommended(ids: string[]): string | undefined {
  const clean = ids.filter((s) => typeof s === 'string' && s.trim());
  if (clean.length === 0) return undefined;
  // Common defaults across providers — easy wins when they're present.
  const preferences = ['default', 'latest', 'auto'];
  for (const pref of preferences) {
    const hit = clean.find((m) => m.toLowerCase().includes(pref));
    if (hit) return hit;
  }
  // Otherwise the first alphabetically — deterministic + visible without needing
  // a sort UI.
  return [...clean].sort()[0];
}

/**
 * Probe an OpenAI-compatible endpoint for its served model list.
 * Resolves with a DiscoverResult; never throws (any error becomes ok:false).
 */
export function listModels(rawEndpoint: string, apiKey: string): Promise<DiscoverResult> {
  const url = normalizeChatBaseUrl(rawEndpoint);
  if (!url) {
    return Promise.resolve({
      ok: false, endpoint: rawEndpoint || '', models: [],
      error: 'Invalid endpoint URL',
    });
  }

  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const targetUrl = url.toString();

  return new Promise((resolve) => {
    let settled = false;
    const done = (r: DiscoverResult) => { if (!settled) { settled = true; resolve(r); } };

    let req: http.ClientRequest;
    try {
      req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          agent: isHttps ? httpsAgent : httpAgent,
          headers: {
            Accept: 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          timeout: 8000,
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => { body += c.toString(); });
          res.on('end', () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              done({
                ok: false, endpoint: targetUrl, models: [],
                error: `${res.statusCode} ${res.statusMessage || ''}`.trim() + (
                  body ? `: ${body.slice(0, 200)}` : ''
                ),
              });
              return;
            }
            let parsed: unknown;
            try { parsed = JSON.parse(body); } catch {
              done({ ok: false, endpoint: targetUrl, models: [], error: 'Endpoint did not return JSON' });
              return;
            }
            // OpenAI shape: { data: [{ id, ... }, ...] }. Some proxies nest it
            // under "models" — accept either. Filter to string ids only; strip
            // duplicates.
            let rawList: unknown[] = [];
            if (parsed && typeof parsed === 'object') {
              const p = parsed as Record<string, unknown>;
              if (Array.isArray(p.data)) rawList = p.data;
              else if (Array.isArray(p.models)) rawList = p.models;
            } else if (Array.isArray(parsed)) {
              rawList = parsed;
            }
            const ids: string[] = [];
            const seen = new Set<string>();
            for (const m of rawList) {
              let id: unknown;
              if (typeof m === 'string') id = m;
              else if (m && typeof m === 'object') id = (m as Record<string, unknown>).id;
              if (typeof id === 'string' && id && !seen.has(id)) { seen.add(id); ids.push(id); }
            }
            const recommended = pickRecommended(ids);
            done({ ok: true, endpoint: targetUrl, models: ids, recommended });
          });
        },
      );
    } catch (e) {
      done({
        ok: false, endpoint: targetUrl, models: [],
        error: `Could not start request: ${(e as Error).message}`,
      });
      return;
    }

    req.on('error', (err) => {
      done({
        ok: false, endpoint: targetUrl, models: [],
        error: `Connection failed: ${err.message}`,
      });
    });
    req.on('timeout', () => {
      try { req.destroy(new Error('timeout')); } catch { /* ignore */ }
      done({ ok: false, endpoint: targetUrl, models: [], error: 'Request timed out (8s)' });
    });
    req.end();
  });
}
