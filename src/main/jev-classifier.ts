// Jev (TypeSafe AI) coordinator: a decision model instead of a chat model.
//
// Jev answers a typed question and returns one option from a list we define,
// with probabilities and a calibrated confidence — no generated text, so there
// is nothing to parse and no way for it to answer off-schema. That is a better
// shape for routing than a chat completion, and it is much faster (~100ms
// typically vs seconds), which matters because this call sits in front of a
// spoken reply.
//
// Same discipline as the chat-model tiebreaker in turn-classifier.ts: bounded
// state, a hard deadline, a confidence floor (a coin-flip verdict is worse than
// the heuristic we already have), and every failure mode returning null so the
// caller keeps the rule-based answer.
//
// API: POST https://api.typesafe.ai/v1/systemone
//   { state, model, questions: { <key>: { type: 'choice', instructions, criteria } } }
//   -> { model, answers: { <key>: { choice, confidence, probabilities } }, usage }
//
// NOTE: verified against the published API reference, not against a live key —
// there is no TypeSafe account on this machine yet. The contract is pinned by
// scripts/smoke-turn-classifier.js against a mock that mirrors that reference.

import http from 'http';
import https from 'https';
import { URL } from 'url';
import type { Target } from './router';
import { credentialedEndpointSecurityError } from './endpoint-security';

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 2 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 2 });

export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
export const JEV_TIMEOUT_MS = 900;
export const JEV_MAX_STATE_CHARS = 1000;
export const JEV_MAX_RESPONSE_BYTES = 8192;
/** Below this, Jev is guessing, and the rules are a better bet than a coin flip. */
export const JEV_CONFIDENCE_FLOOR = 0.6;

export const JEV_INSTRUCTIONS =
  'Who should handle this spoken request from the user? ' +
  'Choose agent when it needs live or external data, a device or system action, ' +
  'a file or code change, a multi-step task, or when the user explicitly asked ' +
  'for the agent. Choose chat when it is knowledge, explanation, advice, ' +
  'reasoning, math, translation, rewriting, brainstorming, creative writing, or ' +
  'small talk.';

export const JEV_CRITERIA = {
  chat: 'Answered from knowledge alone: explanation, advice, reasoning, arithmetic, translation, rewriting, brainstorming, creative writing, small talk.',
  agent: 'Needs to look something up or do something: live data, web search, the screen, files, code, calendar, messages, timers, or device control.',
} as const;

export interface JevOptions {
  endpoint?: string;
  apiKey?: string | null;
  model?: string;
  timeoutMs?: number;
  /** Minimum confidence to act on. Defaults to JEV_CONFIDENCE_FLOOR. */
  confidenceFloor?: number;
}

export interface JevVerdict {
  target: Target;
  confidence: number;
  probabilities?: Record<string, number>;
}

/** Parse a Jev response body. Exported for tests; tolerant, never throws. */
export function parseJevReply(body: unknown, floor = JEV_CONFIDENCE_FLOOR): JevVerdict | null {
  const answers = (body as { answers?: Record<string, { choice?: unknown; confidence?: unknown; probabilities?: unknown }> } | null)?.answers;
  const answer = answers?.target;
  if (!answer) return null;
  const choice = answer.choice;
  if (choice !== 'chat' && choice !== 'agent') return null;
  const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
    ? answer.confidence
    : (typeof answer.probabilities === 'object' && answer.probabilities !== null
      ? Number((answer.probabilities as Record<string, unknown>)[choice])
      : NaN);
  if (!Number.isFinite(confidence)) return null;
  if (confidence < floor) return null;
  return {
    target: choice === 'agent' ? 'harness' : 'llm',
    confidence,
    probabilities: (answer.probabilities as Record<string, number>) || undefined,
  };
}

/** Ask Jev who should handle `message`. Null on any failure or weak verdict. */
export async function classifyTargetWithJev(message: string, opts: JevOptions = {}): Promise<JevVerdict | null> {
  const state = (message || '').trim().slice(0, JEV_MAX_STATE_CHARS);
  if (!state) return null;

  const endpoint = opts.endpoint || JEV_DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // A TypeSafe key must never travel in the clear to a non-loopback host.
  if (credentialedEndpointSecurityError(url, !!opts.apiKey)) return null;

  const body = JSON.stringify({
    state,
    model: opts.model || JEV_DEFAULT_MODEL,
    questions: {
      target: {
        type: 'choice',
        instructions: JEV_INSTRUCTIONS,
        criteria: { chat: JEV_CRITERIA.chat, agent: JEV_CRITERIA.agent },
      },
    },
  });

  const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
  const floor = opts.confidenceFloor ?? JEV_CONFIDENCE_FLOOR;

  return new Promise<JevVerdict | null>((resolve) => {
    let settled = false;
    const done = (v: JevVerdict | null) => { if (!settled) { settled = true; resolve(v); } };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

    const isHttps = url.protocol === 'https:';
    const req = (isHttps ? https : http).request(
      url,
      { method: 'POST', headers, agent: isHttps ? httpsAgent : httpAgent, timeout: timeoutMs },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (raw.length < JEV_MAX_RESPONSE_BYTES) raw += chunk;
        });
        res.on('end', () => {
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) return done(null);
          try {
            done(parseJevReply(JSON.parse(raw), floor));
          } catch {
            done(null);
          }
        });
        res.on('error', () => done(null));
        res.on('aborted', () => done(null));
      },
    );
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    setTimeout(() => { req.destroy(); done(null); }, timeoutMs + 250).unref();
    req.end(body);
  });
}
