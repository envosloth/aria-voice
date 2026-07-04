import { config } from './config';
import { getSecret } from './secure-storage';
import { streamChat, LlmCallbacks, ChatMessage, ChatHandle } from './llm-stream';
import { route, visionDetailFor, Target } from './router';
import { perfMark } from './perf';

export interface CoordinatorCallbacks extends LlmCallbacks {
  onRoute?: (info: { target: Target; name: string }) => void;
}

const TARGET_NAMES: Record<Target, string> = { llm: 'LLM', harness: 'Agent' };

// Shared conversation history. BOTH the conversational LLM and the agent harness
// receive the same running transcript, so context is preserved across a handoff
// (e.g. the harness asks "where are you?", the user answers, and the answer is
// delivered with the full prior context regardless of which target it routes to).
//
// The two targets get DIFFERENT system prompts. The conversational LLM has no
// tools (routing decides tool use up front, see router.ts), so it's told to just
// answer from knowledge. The agent harness runs its OWN tool loop server-side;
// giving it ARIA's old "be concise … use your tools to answer directly" prompt
// made it role-play tool use — it asserted "Done / the file's in place" without a
// tool ever running (hallucinated tool calls). The harness prompt below keeps only
// the voice context and adds the anti-confabulation rule: report a result only
// after a tool actually returned it.
const LLM_SYSTEM_PROMPT =
  'You are ARIA, a local-first voice assistant. You are spoken to and your ' +
  'reply is read aloud, so be concise and natural. Answer from your own ' +
  'knowledge and reasoning. Never tell the user to ask another assistant or open ' +
  'another app; you are the assistant. If you need a detail (such as the user\'s ' +
  'location), ask one brief follow-up question.\n\n' +
  'Critical honesty rules — you have NO tools, NO internet, and NO live data: ' +
  '(1) If asked about anything current (the time, date, weather, news, prices, ' +
  'scores, traffic, what\'s on screen), say plainly that you can\'t check live ' +
  'information right now — NEVER guess or invent a specific value. ' +
  '(2) NEVER claim you performed an action (opened, sent, set, created, looked ' +
  'up anything) — you cannot; say you\'re unable to do that from here. ' +
  '(3) NEVER invent specific facts, numbers, dates, quotes, or URLs you are ' +
  'not confident of; say you don\'t know. A short honest answer beats a ' +
  'plausible made-up one every time.\n\n' +
  'Voice-output rules (read aloud text): speak in natural sentences; ' +
  'NEVER name symbols by their linguistic name ("a circumflex", "called a caret", ' +
  '"the tilde", "the asterisk") — describe the user\'s intent instead, or use the ' +
  'word "caret" only if spelling out keyboard input. NEVER read out raw ' +
  'URLs, file paths, or code — describe what they point to. NEVER include ' +
  'emoji, Markdown emphasis, bullet markers, or fenced code blocks. Use ' +
  'contractions and short sentences so the voice sounds human.';

const HARNESS_SYSTEM_PROMPT =
  'You are reached through ARIA, a voice assistant: the user\'s message is ' +
  'transcribed speech and your reply is read aloud, so keep your final summary ' +
  'short and natural. You have access to tools (web search, file system, code ' +
  'execution, calendar, weather, etc.) — you MUST call a tool to get any ' +
  'information you do not already know. ' +
  '\n\nWHEN TO USE TOOLS (this is the rule users care about most): ' +
  'Call a tool for ANY factual question whose answer could change over time ' +
  'or that you have not been shown a tool result for in this conversation. ' +
  'If unsure, call a tool. The cost of an unnecessary tool call is a few ' +
  'hundred milliseconds; the cost of a hallucinated answer is the user ' +
  'losing trust in you. ' +
  '\n\nVoice-output rules (read aloud text): speak in natural sentences; ' +
  'NEVER name symbols by their linguistic name ("a circumflex", "called a caret", ' +
  '"the tilde", "the asterisk") — describe the user\'s intent instead. ' +
  'NEVER read out raw URLs, file paths, or code — describe what they point to. ' +
  'NEVER include emoji, Markdown emphasis, bullet markers, or fenced code ' +
  'blocks in your final reply. Use contractions and short sentences. ' +
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
  'explanations of things you know), answer directly without tools.';

const MAX_TURNS = 24; // cap history (messages, excluding system) to bound payload
let history: ChatMessage[] = [];
let lastTarget: Target | null = null;

// Handle to the request currently streaming a reply, so a barge-in (the user
// says the wake word while ARIA is talking) can abort generation immediately.
let activeHandle: ChatHandle | null = null;

export function resetConversation(): void {
  history = [];
  lastTarget = null;
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
  turnId?: string;        // latency-harness correlation id (see perf.ts)
}

export async function coordinate(
  userMessage: string,
  cb: CoordinatorCallbacks,
  opts: CoordinateOptions = {},
): Promise<void> {
  const turnId = opts.turnId || '';
  const llmEndpoint = config.get('llm.endpoint') as string;
  const harnessEndpoint = config.get('harness.endpoint') as string;
  const mode = (config.get('routing.mode') as 'auto' | 'llm' | 'harness') || 'auto';
  const hasLlm = !!llmEndpoint;
  const hasHarness = !!harnessEndpoint;

  if (!hasLlm && !hasHarness) {
    cb.onError('No LLM or agent harness configured yet. Open Settings (gear icon) to add one.');
    return;
  }

  // Record the user turn up front so context is shared no matter where it routes.
  // Only the text is stored in history (not the base64 frame) to bound payload
  // size — the image is attached to this request alone.
  history.push({ role: 'user', content: userMessage });
  if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);

  // Did the previous reply end with a question? (it's the message just before the
  // user turn we pushed above) — used to keep an answer on the same target.
  const prevReply = history.length >= 2 ? history[history.length - 2] : null;
  const prevText = prevReply && typeof prevReply.content === 'string' ? prevReply.content : '';
  const lastWasQuestion = !!(prevReply && prevReply.role === 'assistant' && /\?\s*$/.test(prevText));

  // A screen-share frame is visual context for the agent: prefer the harness
  // (the agent that can see + act on the screen) when one is configured.
  const primary: Target = opts.image && hasHarness
    ? 'harness'
    : route(userMessage, { mode, hasLlm, hasHarness, lastTarget, lastWasQuestion });
  const fallback: Target | null =
    primary === 'harness' && hasLlm ? 'llm' :
    primary === 'llm' && hasHarness ? 'harness' : null;

  // `withImage` attaches the screen frame to THIS run. We never forward the image
  // on a fallback to a different target (a plain LLM usually can't take images —
  // that was the source of the `unknown variant image_url` 400), and we retry the
  // same target without the image if it rejects vision.
  const run = async (target: Target, isFallback: boolean, withImage: boolean) => {
    const { endpoint, model, apiKeyName } = await resolve(target);
    const apiKey = await getSecret(apiKeyName);
    cb.onRoute?.({ target, name: TARGET_NAMES[target] + (isFallback ? ' (fallback)' : '') });

    // Routing invariant: the direct conversational LLM is invoked with ZERO tools
    // at the model level — it never calls tools (including delegation). Any request
    // that needs live tools/system access is sent to the agent harness by the
    // pre-invocation router (see router.ts), which runs the tools server-side and
    // weaves the result into its own reply. The harness path therefore handles all
    // tool use; this path is conversation/reasoning/knowledge only.
    // ponytail: history stores only assistant TEXT, so the harness's real
    // tool_calls/results aren't replayed on later turns. Faithful replay would
    // need ARIA to capture server-side tool results (it only sees streamed tool
    // events today) — a real refactor. Add it if multi-turn agent tasks still
    // drift after the prompt split.
    const systemContent = target === 'harness' ? HARNESS_SYSTEM_PROMPT : LLM_SYSTEM_PROMPT;
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
    const markFirstToken = () => { if (!sawFirstToken) { sawFirstToken = true; perfMark(turnId, 'first_token'); } };

    const finishWith = (fullText: string) => {
      lastTarget = target;
      if (fullText && fullText.trim()) history.push({ role: 'assistant', content: fullText });
      if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);
      perfMark(turnId, 'llm_done', { chars: (fullText || '').length });
      cb.onDone(fullText);
    };

    activeHandle = streamChat({ endpoint, model, apiKey, messages }, {
      onToken: (token) => { markFirstToken(); cb.onToken(token); },
      // The harness streams its own server-side tool calls as UI chips via onTool.
      onTool: cb.onTool,
      onDone: (fullText) => finishWith(fullText),
      onError: (err) => {
        // This target can't accept the screen image — retry it WITHOUT the image
        // so the user still gets a text answer instead of a hard 400.
        if (withImage && isVisionUnsupportedError(err)) {
          void run(target, isFallback, false);
          return;
        }
        // On a connection failure, try the OTHER configured target once (no image).
        if (!isFallback && fallback && isConnectionError(err)) {
          void run(fallback, true, false);
          return;
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
