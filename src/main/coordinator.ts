import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { config } from './config';
import { audioTagsActive, expressivePrompt, stripAudioTags } from './audio-tags';
import { classifyToneWithJev, ToneVerdict } from './jev-tone';
import { getSecret } from './secure-storage';
import { streamChat, LlmCallbacks, ChatMessage, ChatHandle, TokenUsage } from './llm-stream';
import { credentialedEndpointSecurityError, requestHostname } from './endpoint-security';
import { routeDetailed, visionDetailFor, Target } from './router';
import { classifyTurn, CoordinatorId } from './turn-classifier';
import { matchLocalIntent, answerFor, nextOccurrence, humanizeMs, formatClock, LocalIntent } from './local-intents';
import * as timers from './timers';
import { perfMark } from './perf';
import * as sessions from './sessions';
import { findForgetTarget, renderMemoryBlock, selectMemories, MemoryItem } from './user-memory';
import { memoryStore } from './user-memory-app';
import { buildContextBlock, detectContextRefs, isTextWorkOnContext, UsedContext } from './context-refs';
import { captureContext } from './context-capture';

export interface CoordinatorCallbacks extends LlmCallbacks {
  onRoute?: (info: { target: Target; name: string }) => void;
  onContext?: (used: UsedContext[]) => void;
}

const TARGET_NAMES: Record<Target, string> = { llm: 'LLM', harness: 'Agent' };

// Session persistence is best-effort: a full disk, read-only userData, or a
// corrupt store must never block streaming a reply or delivering onDone.
function persistSafely(what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`[coordinator] session persistence failed (${what}): ${(error as Error).message}`);
  }
}

// Text length of a chat message's content (image_url/vision parts skipped) —
// used only for the ~chars/4 token estimate when a server doesn't report usage.
function textLength(content: ChatMessage['content']): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      const t = (part as Record<string, unknown>)?.text;
      if (typeof t === 'string') n += t.length;
    }
    return n;
  }
  return 0;
}

// Shared conversation history. BOTH the conversational LLM and the agent harness
// receive the same running transcript, so context is preserved across routes
// (e.g. the harness asks "where are you?", the user answers, and the answer is
// delivered with the full prior context regardless of which target it routes to).
//
// ONE persona, shared VERBATIM by both targets, so the assistant sounds like one
// brain no matter which mode answers. Only the BEHAVIOR rules (run tools vs
// delegate) stay split below — v2.8.2 showed that sharing the behavior prompt
// makes the harness role-play tool use ("Done / the file's in place" with no tool
// run); sharing the persona is what keeps the voice consistent.
const ARIA_PERSONA =
  'You are ARIA, a local-first voice assistant. You are spoken to and your ' +
  'reply is read aloud, so be concise and natural. You are ONE assistant with ' +
  'ONE continuous memory of this conversation. Internally some turns are ' +
  'answered with live tools (web search, files, code, calendar, weather, device ' +
  'actions) and some without; that is an implementation detail the user must ' +
  'never hear about. Never mention modes, agents, harnesses, routers, models, ' +
  '"another assistant", or handing anything off, and never tell the user to ask ' +
  'someone or something else: you are the one who helps. Every earlier turn in ' +
  'the transcript was you, so use what was already said and never ask the user ' +
  'to repeat it. Transcript notes like "[agent tools used: ...]" are private ' +
  'records of which tools you ran for that reply; never read them aloud.\n\n';

const VOICE_RULES =
  '\n\nVoice-output rules (read aloud text): speak in natural sentences; ' +
  'NEVER name symbols by their linguistic name ("a circumflex", "called a caret", ' +
  '"the tilde", "the asterisk") — describe the user\'s intent instead, or use the ' +
  'word "caret" only if spelling out keyboard input. NEVER read out raw ' +
  'URLs, file paths, or code — describe what they point to. NEVER include ' +
  'emoji, Markdown emphasis, bullet markers, or fenced code blocks. Use ' +
  'contractions and short sentences so the voice sounds human.';

const LLM_SYSTEM_PROMPT = ARIA_PERSONA +
  'For this reply you have no live tools. Answer self-contained questions from ' +
  'your own knowledge and reasoning. If the request needs something only live ' +
  'tools can give (current weather, news, prices, the time, the user\'s files, ' +
  'screen, calendar, or any action on the computer), do not explain why you ' +
  'cannot: in one short sentence, offer to do it yourself in the first person, ' +
  'naming the exact thing, e.g. "Want me to check the weather in Longmont?" ' +
  'If a needed detail is missing, ask only for that detail ("Which city?"). If ' +
  'speech recognition garbled a word, make your best guess and confirm it inside ' +
  'the same offer rather than asking twice.\n\n' +
  'Critical honesty rules: ' +
  '(1) If asked about anything current (the time, date, weather, news, prices, ' +
  'scores, traffic, local events, what\'s on screen), NEVER guess or invent a value. ' +
  '(2) NEVER claim YOU performed an action (opened, sent, set, created, looked ' +
  'up anything) unless the transcript contains an actual result. ' +
  '(3) NEVER invent specific facts, numbers, dates, quotes, or URLs you are not ' +
  'confident of; say you don\'t know. A short honest answer beats a plausible ' +
  'made-up one every time.' +
  VOICE_RULES;

const HARNESS_SYSTEM_PROMPT = ARIA_PERSONA +
  'For this reply you have live tools: keep your final summary short and natural. ' +
  'You have access to tools (web search, file system, code ' +
  'execution, calendar, weather, etc.) — you MUST call a tool to get any ' +
  'information you do not already know. ' +
  '\n\nWHEN TO USE TOOLS (this is the rule users care about most): ' +
  'Call a tool for ANY factual question whose answer could change over time ' +
  'or that you have not been shown a tool result for in this conversation. ' +
  'If unsure, call a tool. The cost of an unnecessary tool call is a few ' +
  'hundred milliseconds; the cost of a hallucinated answer is the user ' +
  'losing trust in you. ' +
  '\n\nCritical anti-hallucination rules: ' +
  '(1) NEVER claim a tool ran or returned a result unless you actually invoked it ' +
  'and saw the response in this conversation. If your tool result is missing, ' +
  'say "I wasn\'t able to look that up". ' +
  '(2) NEVER invent specific facts, numbers, dates, file contents, or URLs. ' +
  'If you did not run a tool to verify a fact, say you don\'t know. ' +
  '(3) If a tool fails or returns an error, say so plainly — do not paper over it. ' +
  '(4) When a user asks for live data (time, weather, news, scores, prices, ' +
  'directions, "what\'s on my screen"), you MUST use a tool — your training data ' +
  'is stale and any unreferenced answer is a hallucination. ' +
  '(5) Prefer one well-targeted tool call over guessing. ' +
  '(6) If the user asks you to do something on their computer (open, edit, ' +
  'create, run, install, send, search, look up), you MUST call a tool — ' +
  'do not describe what you would do, do it. ' +
  '\n\nIf the user asks a pure-conversation question (greetings, opinions, ' +
  'explanations of things you know), answer directly without tools.' +
  VOICE_RULES;

const MAX_TURNS = 24; // cap history (messages, excluding system) to bound payload
let history: ChatMessage[] = [];
let lastTarget: Target | null = null;

// One stable session id for the whole conversation, sent to the agent harness as
// X-Hermes-Session-Id so a local Hermes gateway keeps every turn in the SAME
// session (same sandbox + server-side transcript) instead of hashing the request
// to derive — and rotate — a new session per message. Rotated only by
// resetConversation() (the UI "New session" button), which is exactly when the
// user wants a fresh Hermes session. Non-Hermes harnesses ignore the header.
let harnessSessionId: string | null = null;
function harnessSession(): string {
  if (!harnessSessionId) harnessSessionId = `aria-${randomUUID()}`;
  return harnessSessionId;
}

// Handle to the request currently streaming a reply, so a barge-in (the user
// says the wake word while ARIA is talking) can abort generation immediately.
let activeHandle: ChatHandle | null = null;

export function resetConversation(): void {
  history = [];
  lastTarget = null;
  harnessSessionId = null; // next harness turn opens a fresh Hermes session
  sessions.startNewSession(); // next turn opens a fresh persisted session
}

// Reopen a persisted conversation: restore its transcript as the live history so
// follow-ups continue it, and mark it current so new turns append to it. The
// Hermes session rotates (a fresh server session), but the restored text still
// carries the context to both targets via the shared history. Returns the record
// so the renderer can repaint the transcript.
export function resumeSession(id: string): sessions.SessionRecord | null {
  const rec = sessions.getSession(id);
  if (!rec) return null;
  history = rec.turns.map((t) => ({ role: t.role, content: t.content }));
  if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);
  lastTarget = null;
  harnessSessionId = rec.harnessSessionId || null;
  sessions.setCurrentSession(id);
  return rec;
}

/**
 * Abort the in-flight reply, if any. Called when the user interrupts (wake word
 * or push-to-talk while ARIA is still speaking). The aborted request's tokens
 * are swallowed by streamChat, so no further text/audio reaches the renderer.
 */
export function cancelCoordination(): void {
  if (activeHandle) {
    try { activeHandle.cancel(); } catch { /* already finished */ }
    activeHandle = null;
  }
}

export interface DeleteSessionResult {
  deleted: boolean;
  id: string;
  wasCurrent: boolean;
  harnessSessionId?: string;
  harnessDeleted?: boolean;
  harnessError?: string;
}

function harnessSessionApiUrl(rawEndpoint: string, sessionId: string): URL | null {
  if (!rawEndpoint) return null;
  let url: URL;
  try { url = new URL(rawEndpoint); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let base = url.pathname.replace(/\/+$/, '');
  if (/\/v\d+\/chat\/?completions$/i.test(base)) {
    base = base.replace(/\/v\d+\/chat\/?completions$/i, '');
  } else if (/\/v\d+$/i.test(base)) {
    base = base.replace(/\/v\d+$/i, '');
  } else if (/\/chat\/?completions$/i.test(base)) {
    base = base.replace(/\/chat\/?completions$/i, '');
  } else if (/\/api\/sessions(?:\/.*)?$/i.test(base)) {
    base = base.replace(/\/api\/sessions(?:\/.*)?$/i, '');
  }
  url.pathname = `${base}/api/sessions/${encodeURIComponent(sessionId)}`.replace(/\/+/g, '/');
  url.search = '';
  return url;
}

const DELETE_BODY_CAP = 64 * 1024;       // bytes of error body we will buffer
const DELETE_DEADLINE_MS = 10_000;       // wall clock for the whole DELETE

// Settle-once DELETE of the harness-side session. Every terminal path (request
// error/timeout, response aborted/error/premature close, body cap, overall
// deadline) funnels through finish(), which also tears the transport down.
export function deleteHarnessSession(
  harnessId: string,
  opts: { deadlineMs?: number } = {},
): Promise<{ deleted: boolean; error?: string }> {
  const url = harnessSessionApiUrl(config.get('harness.endpoint') as string, harnessId);
  if (!url) return Promise.resolve({ deleted: false, error: 'No valid agent harness endpoint configured' });
  let apiKey: string | null;
  try {
    apiKey = getSecret('harness-api-key');
  } catch (error) {
    return Promise.resolve({ deleted: false, error: `Can't decrypt harness API key: ${(error as Error).message}` });
  }
  const transportSecurityError = credentialedEndpointSecurityError(url, !!apiKey);
  if (transportSecurityError) return Promise.resolve({ deleted: false, error: transportSecurityError });
  const deadlineMs = opts.deadlineMs && opts.deadlineMs > 0 ? opts.deadlineMs : DELETE_DEADLINE_MS;
  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    let req: http.ClientRequest | null = null;
    let response: http.IncomingMessage | null = null;
    let settled = false;
    let deadline: NodeJS.Timeout | null = null;
    const finish = (deleted: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      if (deadline) { clearTimeout(deadline); deadline = null; }
      try { if (response && !response.destroyed) response.destroy(); } catch { /* already closed */ }
      try { if (req && !req.destroyed) req.destroy(); } catch { /* already closed */ }
      resolve(error === undefined ? { deleted } : { deleted, error });
    };
    deadline = setTimeout(() => finish(false, 'Timed out deleting harness session'), deadlineMs);
    try {
      req = transport.request(
        {
          hostname: requestHostname(url),
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          timeout: 8000,
        },
        (res) => {
          response = res;
          let body = '';
          let bytes = 0;
          let ended = false;
          res.on('data', (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > DELETE_BODY_CAP) {
              finish(false, `Harness returned ${res.statusCode || 'unknown'} with an oversized body`);
              return;
            }
            body += chunk.toString();
          });
          res.on('end', () => {
            ended = true;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) finish(true);
            else if (res.statusCode === 404) finish(false);
            else finish(false, `Harness returned ${res.statusCode || 'unknown'}${body ? `: ${body.slice(0, 160)}` : ''}`);
          });
          res.on('aborted', () => finish(false, 'Harness response was aborted'));
          res.on('error', (e) => finish(false, `Harness response failed: ${e.message}`));
          res.on('close', () => { if (!ended) finish(false, 'Harness response closed before completion'); });
        },
      );
    } catch (e) {
      finish(false, (e as Error).message);
      return;
    }
    const r = req;
    r.on('error', (e) => finish(false, e.message));
    r.on('timeout', () => finish(false, 'Timed out deleting harness session'));
    r.end();
  });
}

export async function deletePersistedSession(id: string): Promise<DeleteSessionResult> {
  const rec = sessions.getSession(id);
  const wasCurrent = sessions.getCurrentSessionId() === id;
  if (!rec) return { deleted: false, id, wasCurrent: false };
  const harnessId = rec.harnessSessionId;
  sessions.deleteSession(id);
  if (wasCurrent) {
    history = [];
    lastTarget = null;
    harnessSessionId = null;
  }

  const result: DeleteSessionResult = { deleted: true, id, wasCurrent };
  if (harnessId) {
    result.harnessSessionId = harnessId;
    const harness = await deleteHarnessSession(harnessId);
    result.harnessDeleted = harness.deleted;
    if (harness.error) result.harnessError = harness.error;
  }
  return result;
}

// Memory commands run locally: the text never leaves the machine to be stored.
// Store failures (locked/corrupt store) are spoken plainly, never swallowed.
function runMemoryIntent(intent: LocalIntent, userMessage: string): string | null {
  try {
    const store = memoryStore();
    switch (intent.kind) {
      case 'memory_add': {
        const item = store.add(intent.text, { source: 'explicit', sourceText: userMessage });
        return `Got it. I'll remember that ${spokenMemory(item)}.`;
      }
      case 'memory_forget': {
        const target = findForgetTarget(store.list(), intent.query);
        if (!target) return "I couldn't tell which memory you mean. You can see and delete them all in the Memory panel.";
        store.remove(target.id);
        return `Okay, I've forgotten that ${spokenMemory(target)}.`;
      }
      case 'memory_forget_all': {
        const n = store.clear();
        return n ? `Done. I've forgotten all ${n} thing${n === 1 ? '' : 's'} I remembered about you.` : "I wasn't remembering anything about you.";
      }
      case 'memory_list': {
        const items = store.list();
        if (!items.length) return "I'm not remembering anything about you yet. Say \"remember that…\" to teach me.";
        const shown = items.slice(0, 5).map(spokenMemory);
        const more = items.length > 5 ? ` And ${items.length - 5} more in the Memory panel.` : '';
        return `I remember that ${shown.join('; that ')}.${more}`;
      }
      default:
        return null;
    }
  } catch (error) {
    return `I couldn't update my memory: ${(error as Error).message}.`;
  }
}

// "I prefer metric" -> "you prefer metric", for spoken confirmation only.
function spokenMemory(item: MemoryItem): string {
  return item.text
    .replace(/\bI am\b/g, 'you are').replace(/\bI'm\b/g, "you're").replace(/\bI've\b/g, "you've")
    .replace(/\bI\b/g, 'you').replace(/\bmy\b/gi, 'your').replace(/\bme\b/g, 'you').replace(/\bmine\b/g, 'yours');
}

// Relevant memories for this turn, rendered for the system prompt. Best-effort:
// an unreadable store must not block a reply (the panel surfaces the error).
function memoryContext(userMessage: string): string {
  try {
    if (config.get('memory.enabled') === false) return '';
    return renderMemoryBlock(selectMemories(memoryStore().list(), userMessage, 1200));
  } catch {
    return '';
  }
}

// Execute a matched local intent and render the spoken confirmation/answer.
// Returns null only for a kind it can't handle (shouldn't happen).
function runLocalIntent(intent: LocalIntent, userMessage = ''): string | null {
  if (intent.kind.startsWith('memory_')) return runMemoryIntent(intent, userMessage);
  const now = new Date();
  switch (intent.kind) {
    case 'time':
    case 'date':
      return answerFor(intent, now);
    case 'timer_set': {
      timers.createTimer('timer', intent.label, Date.now() + intent.ms);
      return `Timer set for ${intent.label}.`;
    }
    case 'alarm_set': {
      const fireAt = nextOccurrence(intent.hour, intent.minute, intent.explicitMeridiem, now);
      const label = formatClock(new Date(fireAt));
      const tomorrow = new Date(fireAt).getDate() !== now.getDate();
      timers.createTimer('alarm', label, fireAt);
      return `Alarm set for ${label}${tomorrow ? ' tomorrow' : ''}.`;
    }
    case 'reminder_set': {
      const fireAt = intent.ms != null
        ? Date.now() + intent.ms
        : nextOccurrence(intent.hour!, intent.minute!, !!intent.explicitMeridiem, now);
      timers.createTimer('reminder', intent.text, fireAt);
      const when = intent.ms != null ? `in ${humanizeMs(intent.ms)}` : `at ${formatClock(new Date(fireAt))}`;
      return `Okay, I'll remind you ${when}: ${intent.text}.`;
    }
    case 'timer_list': {
      const items = timers.listTimers();
      if (!items.length) return "You don't have any timers, alarms, or reminders set.";
      const parts = items.map((r) => {
        if (r.kind === 'timer') return `a timer with ${humanizeMs(r.fireAt - Date.now())} left`;
        if (r.kind === 'alarm') return `an alarm at ${r.label}`;
        return `a reminder at ${formatClock(new Date(r.fireAt))}: ${r.label}`;
      });
      return `You have ${parts.join('; ')}.`;
    }
    case 'timer_cancel': {
      const cancelled = intent.what === 'all'
        ? timers.listTimers()
        : timers.listTimers().filter((r) => r.kind === intent.what);
      const n = timers.cancelTimers(intent.what);
      const what = intent.what === 'all' ? 'timers, alarms, and reminders' : `${intent.what}s`;
      if (!n) return `You don't have any ${what} set.`;
      if (n > 1) return `Cancelled ${n} ${what}.`;
      // Exactly one: name its actual kind ("Cancelled your alarm."), never "your all".
      return `Cancelled your ${intent.what === 'all' ? (cancelled[0]?.kind || 'timer') : intent.what}.`;
    }
    default:
      return null;
  }
}

// The turn classifier is best-effort: a locked keyring or an unreadable secret
// must never break a voice turn, so its key is read defensively.
function readSecretSafely(name: string): string | null {
  try { return getSecret(name) || null; } catch { return null; }
}

interface Endpoint { endpoint: string; model: string; apiKeyName: string; }

async function resolve(target: Target): Promise<Endpoint> {
  if (target === 'harness') {
    return {
      endpoint: config.get('harness.endpoint') as string,
      model: config.get('harness.model') as string,
      apiKeyName: 'harness-api-key',
    };
  }
  return {
    endpoint: config.get('llm.endpoint') as string,
    model: config.get('llm.model') as string,
    apiKeyName: 'llm-api-key',
  };
}

// Connection-type failures are worth retrying on the other target.
function isConnectionError(msg: string): boolean {
  return /connection failed|ECONNREFUSED|timed out|ENOTFOUND|EHOSTUNREACH|socket hang up/i.test(msg);
}

// The endpoint rejected the image content (model/server has no vision support).
// Detected so we can retry the same target with text only.
function isVisionUnsupportedError(msg: string): boolean {
  return /image_url|unknown variant|image|vision|multimodal|content.*must be a string|invalid type.*image/i.test(msg);
}

// The endpoint rejected our credentials (bad/expired key). Worth its own message
// because it's actionable — the user has to fix the key in Settings, not the
// server. This is the common "screen share doesn't work" cause: an image forces
// the harness target, so a stale harness key 401s every screen-share turn while
// normal chat (routed to the LLM) keeps working and hides the problem.
function isAuthError(msg: string): boolean {
  return /\b(401|403)\b|invalid[_ ]api[_ ]key|unauthorized|forbidden/i.test(msg);
}

/**
 * Route a user message to the conversational LLM or the agent harness, then
 * stream the reply. The full shared conversation history is sent to whichever
 * target answers, and the reply is appended to that history. If the chosen
 * target is unreachable, automatically falls back to the other configured
 * target before surfacing an error.
 */
export interface CoordinateOptions {
  image?: string | null; // a data: URL screen-share frame, attached to this turn
  files?: { name: string; text: string }[]; // text files dropped on the composer for this turn
  turnId?: string;        // latency-harness correlation id (see perf.ts)
  // Main-process IPC owns this guard. Superseded streams must not mutate shared
  // history or publish into a newer renderer turn.
  isCurrent?: () => boolean;
}

/**
 * One stand-alone request for the latency test: same endpoint, key and system
 * prompt the real turn would use, but no history, no persisted session, no
 * harness session pin and no tools recorded. Prefers the direct LLM (the fast
 * path real conversation takes) and falls back to the agent harness.
 */
export function oneShotChat(
  text: string,
  onToken: (token: string) => void,
  signal: AbortSignal,
): Promise<{ target: string; text: string }> {
  const target: Target | null = config.get('llm.endpoint') ? 'llm' : config.get('harness.endpoint') ? 'harness' : null;
  if (!target) return Promise.reject(new Error('No LLM or agent harness configured yet. Open Settings (gear icon) to add one.'));
  const which = target === 'harness' ? 'agent harness' : 'LLM';
  return resolve(target).then(({ endpoint, model, apiKeyName }) => new Promise((done, fail) => {
    let apiKey: string | null = null;
    try { apiKey = getSecret(apiKeyName); } catch (e) {
      fail(new Error(`Can't decrypt the stored ${which} API key: ${(e as Error).message}`)); return;
    }
    const ep = endpoint.replace(/^(https?:\/\/[^/]+).*/, '$1');
    let settled = false;
    let handle: ChatHandle | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      fn();
    };
    const abort = () => settle(() => {
      try { handle?.cancel(); } finally {
        fail(Object.assign(new Error('Latency test cancelled'), { name: 'AbortError' }));
      }
    });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    handle = streamChat({
      endpoint, model, apiKey,
      messages: [
        { role: 'system', content: target === 'harness' ? HARNESS_SYSTEM_PROMPT : LLM_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      timeoutMs: target === 'harness' ? 120000 : 30000,
    }, {
      onToken: (t) => { if (!settled && !signal.aborted) onToken(t); },
      onDone: (full) => settle(() => done({ target: TARGET_NAMES[target], text: full })),
      onError: (err) => settle(() => fail(new Error(
        isConnectionError(err) ? `Can't reach your ${which} at ${ep} — is it running?`
          : isAuthError(err) ? `Your ${which} at ${ep} rejected the API key (401/403).` : `${which} error: ${err}`,
      ))),
    });
    if (signal.aborted) handle.cancel();
  }));
}

export async function coordinate(
  userMessage: string,
  cb: CoordinatorCallbacks,
  opts: CoordinateOptions = {},
): Promise<void> {
  const turnId = opts.turnId || '';
  const isCurrent = opts.isCurrent || (() => true);
  if (!isCurrent()) return;
  const llmEndpoint = config.get('llm.endpoint') as string;
  const harnessEndpoint = config.get('harness.endpoint') as string;
  const mode = (config.get('routing.mode') as 'auto' | 'llm' | 'harness') || 'auto';
  const hasLlm = !!llmEndpoint;
  const hasHarness = !!harnessEndpoint;

  // Local instant intents: bare time/date questions and timer/alarm/reminder
  // commands are answered right here — no LLM/harness round-trip — so they
  // speak in ~150ms. Skipped under a hard 'harness' mode override; explicit
  // "ask the agent…" phrasing never matches (see local-intents.ts). Works even
  // with no provider configured at all.
  if (mode !== 'harness') {
    const intent = matchLocalIntent(userMessage);
    const reply = intent ? runLocalIntent(intent, userMessage) : null;
    if (reply) {
      history.push({ role: 'user', content: userMessage });
      persistSafely('record user turn', () => sessions.recordTurn('user', userMessage));
      cb.onRoute?.({ target: 'llm', name: 'Local' });
      perfMark(turnId, 'llm_request', { target: 'local' });
      perfMark(turnId, 'first_token');
      cb.onToken(reply);
      history.push({ role: 'assistant', content: reply });
      if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);
      persistSafely('record assistant turn', () => sessions.recordTurn('assistant', reply));
      perfMark(turnId, 'llm_done', { chars: reply.length, local: 1 });
      cb.onDone(reply);
      return;
    }
  }

  if (!hasLlm && !hasHarness) {
    if (isCurrent()) cb.onError('No LLM or agent harness configured yet. Open Settings (gear icon) to add one.');
    return;
  }

  // Record the user turn up front so context is shared no matter where it routes.
  // Only the text is stored in history (not the base64 frame) to bound payload
  // size — the image is attached to this request alone.
  history.push({ role: 'user', content: userMessage });
  if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);
  persistSafely('record user turn', () => sessions.recordTurn('user', userMessage)); // "past sessions" list

  // Did the previous reply end with a question? (it's the message just before the
  // user turn we pushed above) — used to keep an answer on the same target. The
  // "[agent tools used: …]" note a harness reply may carry is stripped first so
  // it doesn't hide a trailing question mark.
  const prevReply = history.length >= 2 ? history[history.length - 2] : null;
  const prevText = prevReply && typeof prevReply.content === 'string'
    ? prevReply.content.replace(/\n\n\[agent tools used: [^\]]*\]$/, '')
    : '';
  const lastWasQuestion = !!(prevReply && prevReply.role === 'assistant' && /\?\s*$/.test(prevText));

  // ElevenLabs delivery director (a TTS setting, separate from routing). Jev
  // picks the emotional register while routing and context capture proceed;
  // the reply waits for it only up to its own short deadline.
  const tagsOn = audioTagsActive(config.get('tts.engine'), config.get('tts.cloudModels.elevenlabs'), config.get('tts.expressive'));
  const toneStarted = Date.now();
  const tonePromise: Promise<ToneVerdict | null> = tagsOn && config.get('tts.toneDirector') === 'jev'
    ? classifyToneWithJev(userMessage, { apiKey: readSecretSafely('jev-tone-api-key'), previousReply: prevText })
    : Promise.resolve(null);
  let toneLogged = false;
  const awaitTone = async () => {
    const verdict = await tonePromise;
    if (!toneLogged && tagsOn && config.get('tts.toneDirector') === 'jev') {
      toneLogged = true;
      perfMark(turnId, 'tone_directed', { ms: Date.now() - toneStarted, tone: verdict?.tone || 'none' });
    }
    return verdict;
  };
  const prevUser = history.length >= 3 ? history[history.length - 3] : null;
  const prevUserText = prevUser && prevUser.role === 'user' && typeof prevUser.content === 'string' ? prevUser.content : '';

  // Desktop context (roadmap P0.3): only when the utterance points at it and
  // only from sources the user enabled. The block rides on THIS request only
  // (never stored in shared history), and the renderer shows what was read.
  let contextBlock = '';
  const refs = detectContextRefs(userMessage);
  const files = opts.files || [];
  if (files.length) {
    // Dropped files are an explicit hand-over: always attached, no toggle needed.
    const built = buildContextBlock({ files }, []);
    contextBlock = built.text;
    if (built.used.length) cb.onContext?.(built.used);
  } else if (refs.length) {
    const sources = {
      activeApp: config.get('context.activeApp') === true,
      selection: config.get('context.selection') === true,
      clipboard: config.get('context.clipboard') === true,
    };
    if (sources.activeApp || sources.selection || sources.clipboard) {
      try {
        const snap = await captureContext(refs, sources);
        if (!isCurrent()) return;
        const built = buildContextBlock(snap, refs);
        contextBlock = built.text;
        if (built.used.length) cb.onContext?.(built.used);
      } catch (error) {
        console.error(`[coordinator] context capture failed: ${(error as Error).message}`);
      }
    }
  }
  // Text work on text the user just handed over ("summarize this", "translate
  // what I copied") needs no tools: keep it on the fast chat path.
  const contextIsTextWork = !!contextBlock && !opts.image && (isTextWorkOnContext(userMessage) || files.length > 0 && !/\b(?:open|run|execute|install|save|move|rename|delete|commit)\b/i.test(userMessage));

  // A screen-share frame is visual context for the agent: prefer the harness
  // (the agent that can see + act on the screen) when one is configured.
  let primary: Target;
  if (contextIsTextWork && hasLlm && mode === 'auto') {
    primary = 'llm';
  } else if (opts.image && hasHarness) {
    primary = 'harness';
  } else {
    const decision = routeDetailed(userMessage, {
      mode, hasLlm, hasHarness, lastTarget, lastWasQuestion, prevUserText, prevAssistantText: prevText,
    });
    primary = decision.target;
    // The rules recognised this message with a specific cue (an imperative, a
    // knowledge framing, a live lookup, …) — no need to ask anyone else. When
    // they only matched a broad noun or nothing at all, ask the coordinator set
    // in Settings for a second opinion. See turn-classifier.ts.
    // Only for 'auto' mode with both targets configured: a forced target is a
    // user instruction, not a guess.
    const classifierOn = (config.get('routing.classifier') as string) !== 'off';
    const coordinator = ((config.get('routing.coordinator') as CoordinatorId) || 'builtin');
    if (!decision.confident && classifierOn && mode === 'auto' && hasLlm && hasHarness) {
      const started = Date.now();
      const verdict = await classifyTurn(userMessage, {
        coordinator,
        timeoutMs: Number(config.get('routing.classifierTimeoutMs')) || 1500,
        llm: {
          endpoint: llmEndpoint,
          model: (config.get('llm.model') as string) || undefined,
          apiKey: readSecretSafely('llm-api-key'),
        },
        jev: {
          endpoint: (config.get('routing.jevEndpoint') as string) || undefined,
          model: (config.get('routing.jevModel') as string) || undefined,
          apiKey: readSecretSafely('jev-api-key'),
        },
      });
      perfMark(turnId, 'route_classified', {
        ms: Date.now() - started,
        heuristic: decision.target,
        picked: verdict?.target || decision.target,
        by: verdict?.by || 'heuristic',
      });
      if (verdict) primary = verdict.target;
      if (verdict && verdict.target !== decision.target) {
        console.log(`[ARIA] routing: rules said ${decision.target} (${decision.reason}); ${verdict.by} said ${verdict.target} in ${verdict.ms}ms — using ${verdict.target}`);
      } else if (!verdict) {
        console.log(`[ARIA] routing: rules alone decided ${decision.target} (${decision.reason}); the ${coordinator} coordinator had no answer`);
      }
    }
  }
  const fallback: Target | null =
    primary === 'harness' && hasLlm ? 'llm' :
    primary === 'llm' && hasHarness ? 'harness' : null;

  // `withImage` attaches the screen frame to THIS run. We never forward the image
  // on a fallback to a different target (a plain LLM usually can't take images —
  // that was the source of the `unknown variant image_url` 400), and we retry the
  // same target without the image if it rejects vision.
  // Which tools the harness ran this turn — recorded into shared history as a
  // bracketed note so the fast chat mode can see WHAT the agent did on earlier
  // turns, not just what it said (one brain, one memory).
  const agentActions: string[] = [];

  const run = async (target: Target, isFallback: boolean, withImage: boolean) => {
    if (!isCurrent()) return;
    const { endpoint, model, apiKeyName } = await resolve(target);
    if (!isCurrent()) return;
    // getSecret throws when the stored key can't be decrypted (keyring locked or
    // switched). Without this guard the turn dies as an unhandled rejection —
    // no reply, no error, nothing spoken — on every request path. Surface it instead.
    let apiKey: string | null = null;
    try {
      apiKey = await getSecret(apiKeyName);
    } catch (e) {
      if (!isCurrent()) return;
      cb.onError(
        `Can't decrypt the stored ${target === 'harness' ? 'agent harness' : 'LLM'} API key ` +
        `(system keyring locked or changed): ${(e as Error).message}. ` +
        'Unlock your keyring or re-enter the key in Settings.',
      );
      return;
    }
    if (!isCurrent()) return;
    cb.onRoute?.({
      target,
      name: TARGET_NAMES[target] + (isFallback ? ' (fallback)' : ''),
    });

    // Routing contract: router.ts chooses the harness before an agentic turn is
    // sent. The conversational model receives no delegation tool or sentinel.
    // History records a compact note for tools the harness itself ran.
    const tone = await awaitTone();
    if (!isCurrent()) return;
    const systemContent = (target === 'harness' ? HARNESS_SYSTEM_PROMPT : LLM_SYSTEM_PROMPT)
      + expressivePrompt(config.get('tts.engine'), config.get('tts.cloudModels.elevenlabs'), config.get('tts.expressive'), tone?.tone)
      + memoryContext(userMessage) + contextBlock;
    // The "voice output" hint is appended to the LAST user message because
    // LLMs reliably follow user-message instructions but inconsistently
    // follow system-prompt rules. This is a small per-turn nudge that
    // re-emphasises the no-symbol-names rule right where the model is
    // generating the answer — much more effective than putting it only
    // in the system prompt. Cheap (~30 tokens per turn) and strip-safe
    // (we remove the hint from the final TTS text by anchoring on the
    // exact prefix).
    const voiceOutputHint =
      '\n\n[Voice output] Your reply is read aloud by a TTS engine. Use natural ' +
      'spoken English. Do NOT name symbols by their linguistic name ' +
      '("a circumflex", "called a caret", "the tilde", "the asterisk") — ' +
      'describe intent instead. Do NOT read out URLs, file paths, or ' +
      'code. Do NOT include emoji, Markdown emphasis, bullet markers, ' +
      'or fenced code blocks. Be concise.';
    const messages: ChatMessage[] = [{ role: 'system', content: systemContent }, ...history];
    // Attach the voice hint to the last user turn (the one being answered
    // this call) so the nudge is fresh. We don't modify the shared history
    // — the hint is per-request only.
    if (messages.length > 0) {
      const lastIdx = messages.length - 1;
      const last = messages[lastIdx];
      if (last && last.role === 'user') {
        const prev = typeof last.content === 'string' ? last.content : '';
        messages[lastIdx] = { role: 'user', content: prev + voiceOutputHint };
      }
    }
    // Attach the screen-share frame to the final (current) user message as an
    // OpenAI-vision content array so the agent can see the desktop.
    if (withImage && opts.image) {
      const lastIdx = messages.length - 1;
      const last = messages[lastIdx];
      if (last && last.role === 'user') {
        messages[lastIdx] = {
          role: 'user',
          content: [
            { type: 'text', text: (typeof last.content === 'string' ? last.content : userMessage) || 'Here is my screen.' },
            // detail:"low" for a quick glance, "high" when the ask needs to read fine
            // content — the main lever on screen-share reply latency. See router.ts.
            { type: 'image_url', image_url: { url: opts.image, detail: visionDetailFor(userMessage) } },
          ],
        };
      }
    }

    perfMark(turnId, 'llm_request', { target, model });
    let sawFirstToken = false;
    // Any user-visible output from this run: a streamed token OR a forwarded
    // tool chip. Once set, a retry/fallback would duplicate or contradict what
    // the user already saw (and possibly re-run side-effecting tools).
    let sawActivity = false;
    const markFirstToken = () => { if (!sawFirstToken) { sawFirstToken = true; perfMark(turnId, 'first_token'); } };
    let turnUsage: TokenUsage | null = null;
    const emitToken = (token: string) => {
      if (!isCurrent()) return;
      markFirstToken();
      sawActivity = true;
      cb.onToken(token);
    };

    const finishWith = (fullText: string) => {
      if (!isCurrent()) return;
      lastTarget = target;
      if (fullText && fullText.trim()) {
        // The live history (what both modes are prompted with) also records which
        // tools the agent ran; the persisted/spoken transcript stays clean text.
        const note = target === 'harness' && agentActions.length
          ? `\n\n[agent tools used: ${agentActions.join(', ')}]`
          : '';
        // Delivery tags steer the voice only; transcripts keep the plain words.
        const plainText = audioTagsActive(config.get('tts.engine'), config.get('tts.cloudModels.elevenlabs'), config.get('tts.expressive'))
          ? stripAudioTags(fullText) : fullText;
        history.push({ role: 'assistant', content: plainText + note });
        persistSafely('record assistant turn', () => sessions.recordTurn('assistant', plainText));
      }
      if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);
      // Attribute tokens spent to the current session, split by target. Prefer the
      // server-reported usage; fall back to a ~chars/4 estimate so the meter still
      // moves for endpoints that don't report usage.
      const spent = turnUsage
        ? (turnUsage.total || turnUsage.prompt + turnUsage.completion)
        : Math.round((messages.reduce((n, m) => n + textLength(m.content), 0) + (fullText || '').length) / 4);
      persistSafely('add session tokens', () => sessions.addSessionTokens(target, spent));
      perfMark(turnId, 'llm_done', { chars: (fullText || '').length });
      cb.onDone(fullText);
    };

    // Harness turns: pin the Hermes session (continuity across messages) and give
    // the agent room to run tools. A web search / browse / code run can sit silent
    // well past the 30s default inactivity timeout — that silent kill is the "asked
    // the agent and it never answered" bug. The direct LLM keeps the tight default.
    let harnessHeaders: Record<string, string> | undefined;
    if (target === 'harness') {
      const sid = harnessSession();
      persistSafely('pin harness session', () => sessions.setCurrentHarnessSession(sid));
      harnessHeaders = { 'X-Hermes-Session-Id': sid };
    }
    const timeoutMs = target === 'harness' ? 120000 : 30000;

    if (!isCurrent()) return;
    activeHandle = streamChat({ endpoint, model, apiKey, messages, headers: harnessHeaders, timeoutMs }, {
      onToken: emitToken,
      // The harness streams its own server-side tool calls as UI chips via onTool;
      // their names are also captured for the history note (see finishWith).
      // The direct LLM has no tools: any tool event it emits is ignored — not
      // forwarded as a chip and not recorded as an agent action.
      onTool: (info) => {
        if (!isCurrent() || target !== 'harness') return;
        sawActivity = true;
        if (info.name && !agentActions.includes(info.name)) agentActions.push(info.name);
        cb.onTool?.(info);
      },
      onUsage: (u) => { turnUsage = u; },
      onDone: (fullText) => finishWith(fullText),
      onError: (err) => {
        if (!isCurrent()) return;
        // Invariant: never retry or fall back once reply TEXT or a tool event has
        // reached the renderer. A second stream would concatenate onto the partial reply
        // already shown (and re-spoken by TTS) — e.g. a harness that drops the
        // socket mid-answer. Past this point, surface the error instead. (The
        // retry cases below normally fire before any token, so this only guards
        // the mid-stream-drop edge.)
        if (!sawActivity) {
          // This target can't accept the screen image — retry it WITHOUT the image
          // so the user still gets a text answer instead of a hard 400.
          if (withImage && isVisionUnsupportedError(err)) {
            void run(target, isFallback, false);
            return;
          }
          // On a connection failure, try the OTHER configured target once (no image).
          if (!isFallback && fallback && fallback !== target && isConnectionError(err)) {
            void run(fallback, true, false);
            return;
          }
        }
        const which = target === 'harness' ? 'agent harness' : 'LLM';
        const ep = endpoint.replace(/^(https?:\/\/[^/]+).*/, '$1');
        if (isConnectionError(err)) {
          cb.onError(
            `Can't reach your ${which} at ${ep} — is it running? ` +
            'Check Settings → endpoint, start the server (e.g. Ollama / your harness), ' +
            'or configure a reachable endpoint. Text input still works.',
          );
        } else if (isAuthError(err)) {
          const where = target === 'harness' ? 'Agent Harness' : 'Conversational LLM';
          cb.onError(
            `Your ${which} at ${ep} rejected the API key (401/403). ` +
            `Open Settings → ${where} and re-enter a valid API key. ` +
            (target === 'harness' ? 'Screen share always routes here, so it fails until the key is fixed.' : ''),
          );
        } else {
          cb.onError(`${which} error: ${err}`);
        }
      },
    });
  };

  // Only the primary target (the one chosen because of the image) gets the frame.
  await run(primary, false, !!opts.image);
}
