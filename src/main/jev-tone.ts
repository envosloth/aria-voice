// Jev (TypeSafe) as the delivery director for ElevenLabs expressive tags.
//
// A typed one-question call that picks the reply's emotional register; the
// reply model then places (or withholds) the actual [tags]. It is independent
// of the routing coordinator: its own setting, its own key alias, and it runs
// concurrently with routing so it adds latency only if it outlasts the
// routing/context work, and never beyond its hard deadline. Any failure
// returns null and the reply model decides alone, exactly as without Jev.

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { credentialedEndpointSecurityError } from './endpoint-security';
import { JEV_DEFAULT_ENDPOINT, JEV_DEFAULT_MODEL } from './jev-classifier';

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 2 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 2 });

export const TONES = ['playful', 'warm', 'calm', 'serious', 'neutral'] as const;
export type Tone = typeof TONES[number];
export const JEV_TONE_TIMEOUT_MS = 700;
export const JEV_TONE_CONFIDENCE_FLOOR = 0.5;
export const JEV_TONE_MAX_STATE_CHARS = 1200;
const MAX_RESPONSE_BYTES = 8192;

const INSTRUCTIONS =
  'A voice assistant is about to answer the user out loud. Which emotional register ' +
  'should its spoken delivery use? Match the user\'s mood and the nature of the request.';
const CRITERIA: Record<Tone, string> = {
  playful: 'Jokes, banter, teasing, light fun, celebrating something silly.',
  warm: 'Thanks, good news, encouragement, friendly personal chat.',
  calm: 'Stress, frustration, sadness, worry, or anything needing reassurance.',
  serious: 'Bad news, safety, health, money, or grave or sensitive topics.',
  neutral: 'Plain facts, instructions, lookups, technical or task-focused answers.',
};

export interface ToneOptions {
  endpoint?: string;
  apiKey?: string | null;
  model?: string;
  timeoutMs?: number;
  previousReply?: string;
}
export interface ToneVerdict { tone: Tone; confidence: number; }

export function parseToneReply(body: unknown, floor = JEV_TONE_CONFIDENCE_FLOOR): ToneVerdict | null {
  const answer = (body as { answers?: { tone?: { choice?: unknown; confidence?: unknown } } } | null)?.answers?.tone;
  if (!answer || !(TONES as readonly unknown[]).includes(answer.choice)) return null;
  const confidence = Number(answer.confidence);
  if (!Number.isFinite(confidence) || confidence < floor) return null;
  return { tone: answer.choice as Tone, confidence };
}

export async function classifyToneWithJev(message: string, opts: ToneOptions = {}): Promise<ToneVerdict | null> {
  const user = (message || '').trim();
  if (!user || !opts.apiKey) return null;
  const prev = (opts.previousReply || '').trim().slice(0, 300);
  const state = ((prev ? `Assistant just said: ${prev}\n` : '') + `User: ${user}`).slice(0, JEV_TONE_MAX_STATE_CHARS);
  let url: URL;
  try { url = new URL(opts.endpoint || JEV_DEFAULT_ENDPOINT); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (credentialedEndpointSecurityError(url, true)) return null;

  const body = JSON.stringify({
    state,
    model: opts.model || JEV_DEFAULT_MODEL,
    questions: { tone: { type: 'choice', instructions: INSTRUCTIONS, criteria: CRITERIA } },
  });
  const timeoutMs = opts.timeoutMs ?? JEV_TONE_TIMEOUT_MS;
  return new Promise<ToneVerdict | null>((resolve) => {
    let settled = false;
    const done = (v: ToneVerdict | null) => { if (!settled) { settled = true; clearTimeout(wall); resolve(v); } };
    const isHttps = url.protocol === 'https:';
    const req = (isHttps ? https : http).request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), Authorization: `Bearer ${opts.apiKey}` },
      agent: isHttps ? httpsAgent : httpAgent,
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (raw.length < MAX_RESPONSE_BYTES) raw += c; });
      res.on('end', () => {
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) return done(null);
        try { done(parseToneReply(JSON.parse(raw))); } catch { done(null); }
      });
      res.on('error', () => done(null));
      res.on('aborted', () => done(null));
    });
    const wall = setTimeout(() => { req.destroy(); done(null); }, timeoutMs);
    wall.unref();
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    req.end(body);
  });
}
