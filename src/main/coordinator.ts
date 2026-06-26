import { config } from './config';
import { getSecret } from './secure-storage';
import { streamChat, LlmCallbacks, ChatMessage, ChatHandle, ToolCall } from './llm-stream';
import { route, Target } from './router';
import { perfMark } from './perf';

export interface CoordinatorCallbacks extends LlmCallbacks {
  onRoute?: (info: { target: Target; name: string }) => void;
}

const TARGET_NAMES: Record<Target, string> = { llm: 'LLM', harness: 'Agent' };

// Shared conversation history. BOTH the conversational LLM and the agent harness
// receive the same running transcript, so context is preserved across a handoff
// (e.g. the harness asks "where are you?", the user answers, and the answer is
// delivered with the full prior context regardless of which target it routes to).
const SYSTEM_PROMPT =
  'You are ARIA, a local-first voice assistant. You are spoken to and your ' +
  'replies are read aloud, so be concise and natural. You have access to live ' +
  'tools and the user\'s system — when asked for real-time information (weather, ' +
  'news, the time, what is on screen, etc.) use your tools to answer directly. ' +
  'Never tell the user to ask another assistant or open another app; you are the ' +
  'assistant. If you need a detail (such as the user\'s location), ask one brief ' +
  'follow-up question.';

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

// The endpoint rejected the `tools` field / has no tool-calling support. Detected
// so a direct LLM that can't do function calling falls back to a plain text reply
// instead of erroring. Broad on purpose — a false positive just means one retry
// without tools (harmless).
function isToolsUnsupportedError(msg: string): boolean {
  return /tool/i.test(msg) &&
    /(not support|unsupported|unknown|invalid|unrecognized|no endpoints|does not|cannot|not allow|400|404|422|501)/i.test(msg);
}

// The single tool offered to a DIRECT conversational LLM: hand a task that needs
// live tools/system access to the configured agent harness (which actually has
// them). This is how a plain chat model "delegates to the tool-use harness".
const DELEGATE_TOOL = {
  type: 'function',
  function: {
    name: 'delegate_to_agent',
    description:
      'Hand off a task to the agent harness, which has live tools (web search, ' +
      'the time, weather/news, the user\'s screen and system, running commands, ' +
      'code execution). Call this whenever the user needs real-time information or ' +
      'an action you cannot do from your own knowledge, instead of guessing or ' +
      'saying you can\'t. Provide a clear, self-contained task.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The self-contained task for the agent to perform.' },
      },
      required: ['task'],
    },
  },
};

// Appended to the system prompt only when the delegate tool is offered, so the
// model knows the capability exists.
const DELEGATE_SYSTEM_HINT =
  ' You also have a tool, delegate_to_agent, that runs a task on an agent with ' +
  'live tools (web search, real-time data, the user\'s screen, system actions, ' +
  'code). When the user asks for something you cannot answer from your own ' +
  'knowledge — current weather, news, the time, what is on their screen, running ' +
  'a command — call delegate_to_agent rather than guessing or refusing.';

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
  // Run the configured agent harness for a delegated task and resolve its full
  // reply text. The harness's real tool calls are forwarded to the UI as chips so
  // the user sees the handoff. Assigned to activeHandle so a barge-in can abort it.
  const runHarnessForTask = (task: string): Promise<string> =>
    new Promise((done) => {
      void (async () => {
        try {
          const h = await resolve('harness');
          const hKey = await getSecret(h.apiKeyName);
          const hMessages: ChatMessage[] = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...history.slice(0, -1),          // prior context (exclude the current user turn)
            { role: 'user', content: task },  // the delegated, self-contained task
          ];
          activeHandle = streamChat({ endpoint: h.endpoint, model: h.model, apiKey: hKey, messages: hMessages }, {
            onToken: () => { /* aggregated, not streamed to the user directly */ },
            onTool: (info) => cb.onTool?.(info),
            onDone: (text) => done(text || ''),
            onError: () => done(''),          // harness failed -> empty result, LLM will say so
          });
        } catch {
          done('');
        }
      })();
    });

  const run = async (target: Target, isFallback: boolean, withImage: boolean, withTools: boolean) => {
    const { endpoint, model, apiKeyName } = await resolve(target);
    const apiKey = await getSecret(apiKeyName);
    cb.onRoute?.({ target, name: TARGET_NAMES[target] + (isFallback ? ' (fallback)' : '') });

    // Offer the delegate tool ONLY to a direct LLM, and only when a harness exists
    // to delegate to. The harness path runs its own tools, so it never gets it.
    const offerTools = withTools && target === 'llm' && hasHarness;
    const systemContent = offerTools ? SYSTEM_PROMPT + DELEGATE_SYSTEM_HINT : SYSTEM_PROMPT;

    const messages: ChatMessage[] = [{ role: 'system', content: systemContent }, ...history];
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
            { type: 'image_url', image_url: { url: opts.image } },
          ],
        };
      }
    }

    perfMark(turnId, 'llm_request', { target, model, tools: offerTools ? 1 : 0 });
    let sawFirstToken = false;
    const markFirstToken = () => { if (!sawFirstToken) { sawFirstToken = true; perfMark(turnId, 'first_token'); } };

    const finishWith = (fullText: string, delegated: boolean) => {
      lastTarget = target;
      if (fullText && fullText.trim()) history.push({ role: 'assistant', content: fullText });
      if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);
      perfMark(turnId, 'llm_done', { chars: (fullText || '').length, ...(delegated ? { delegated: 1 } : {}) });
      cb.onDone(fullText);
    };

    activeHandle = streamChat({ endpoint, model, apiKey, messages, tools: offerTools ? [DELEGATE_TOOL] : undefined }, {
      onToken: (token) => { markFirstToken(); cb.onToken(token); },
      onTool: cb.onTool,
      // Only the direct-LLM-with-harness path executes tool calls. When the model
      // asks to delegate, run the harness then continue the LLM with the result so
      // it speaks the final answer in its own voice.
      onToolCalls: offerTools ? (calls: ToolCall[]) => {
        void (async () => {
          const del = calls.find((c) => c.name === 'delegate_to_agent') || calls[0];
          let task = userMessage;
          try { const a = JSON.parse(del.arguments || '{}'); if (a && a.task) task = String(a.task); } catch { /* keep userMessage */ }
          // The delegate chip is already surfaced via onTool while the tool call
          // streams in (extractTools), so we don't re-emit it here (avoids ×2).
          const harnessReply = await runHarnessForTask(task);
          const callId = del.id || 'call_0';
          const followup: ChatMessage[] = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...history,
            { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: 'delegate_to_agent', arguments: del.arguments || '{}' } }] },
            { role: 'tool', tool_call_id: callId, content: harnessReply || 'The agent returned no result.' },
          ];
          // No tools this round -> the model produces a final spoken answer rather
          // than looping into another delegation.
          activeHandle = streamChat({ endpoint, model, apiKey, messages: followup }, {
            onToken: (token) => { markFirstToken(); cb.onToken(token); },
            onTool: cb.onTool,
            onDone: (finalText) => finishWith(finalText, true),
            onError: (err) => cb.onError(`LLM error after delegation: ${err}`),
          });
        })();
      } : undefined,
      onDone: (fullText) => finishWith(fullText, false),
      onError: (err) => {
        // Model/server can't do tool calling -> retry this target once WITHOUT tools.
        if (offerTools && isToolsUnsupportedError(err)) {
          void run(target, isFallback, withImage, false);
          return;
        }
        // This target can't accept the screen image — retry it WITHOUT the image
        // so the user still gets a text answer instead of a hard 400.
        if (withImage && isVisionUnsupportedError(err)) {
          void run(target, isFallback, false, withTools);
          return;
        }
        // On a connection failure, try the OTHER configured target once (no image/tools).
        if (!isFallback && fallback && isConnectionError(err)) {
          void run(fallback, true, false, false);
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
        } else {
          cb.onError(`${which} error: ${err}`);
        }
      },
    });
  };

  // Only the primary target (the one chosen because of the image) gets the frame;
  // tool delegation is offered on the first attempt (gated inside run()).
  await run(primary, false, !!opts.image, true);
}
