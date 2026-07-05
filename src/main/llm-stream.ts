import https from 'https';
import http from 'http';
import { URL } from 'url';

// Keep-alive connection pools, shared across every request. Without these Node
// opens a fresh TCP (and, for https providers, a full TLS) connection for EVERY
// turn — a handshake that adds ~100-400ms of dead time before the model can even
// start, on top of the model's own latency. Reusing a warm socket removes that
// per-turn overhead, which is pure win for the "direct LLM should be fast" path.
// maxSockets is small: ARIA issues one streamed request at a time per target.
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8 });

// One fully-assembled tool call the model asked us to run (arguments may stream
// across many deltas; these are accumulated before being surfaced).
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
  // A tool/function the agent harness invoked, surfaced as it streams so the UI
  // can show "what tools are being used" above the final answer. Optional — a
  // plain chat LLM never emits any.
  onTool?: (info: { name: string; args?: string }) => void;
  // The model finished a turn by REQUESTING tool calls (OpenAI function calling)
  // rather than answering. When provided AND the model emitted tool calls, this
  // fires INSTEAD of onDone, handing the assembled calls to the caller to execute
  // and continue the conversation. Used by the direct-LLM delegate-to-agent path;
  // omitted for the harness path (the harness runs its own tools), where tool
  // events just drive onTool chips and onDone fires normally.
  onToolCalls?: (calls: ToolCall[]) => void;
}

// Pull tool/function names out of one parsed SSE JSON object. Supports the
// OpenAI streaming + non-streaming `tool_calls` shape (the de-facto standard a
// harness/proxy emits), the legacy `function_call`, and a couple of generic
// agent-event shapes — so we recognise tool use across harnesses. Returns
// [{name, args, key}] where `key` dedupes a call whose name streams once but
// whose argument fragments stream across many deltas.
function extractTools(obj: unknown): { name: string; args?: string; key: string }[] {
  const out: { name: string; args?: string; key: string }[] = [];
  if (!obj || typeof obj !== 'object') return out;
  const o = obj as Record<string, any>;
  const choice = o.choices?.[0];
  const delta = choice?.delta || choice?.message || {};

  const calls = delta.tool_calls || o.tool_calls;
  if (Array.isArray(calls)) {
    for (const c of calls) {
      const name = c?.function?.name || c?.name;
      if (name) out.push({ name, args: c?.function?.arguments, key: 'idx' + (c?.index ?? c?.id ?? name) });
    }
  }
  const fc = delta.function_call || o.function_call;
  if (fc?.name) out.push({ name: fc.name, args: fc.arguments, key: 'fc:' + fc.name });

  // Generic agent event shapes: {type:'tool_use'|'tool', name|tool|tool_name}
  const t = o.type || o.event;
  const gname = o.tool || o.tool_name || (t && /tool/i.test(String(t)) ? o.name : null);
  if (typeof gname === 'string' && gname) out.push({ name: gname, key: 'g:' + gname });

  return out;
}

// content is a string for normal turns, or an OpenAI-vision content array
// (text + image_url parts) when a screen-share frame is attached.
export type MessageContent = string | Array<Record<string, unknown>>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  // Present on an assistant turn that requested tool calls, and echoed back so
  // the model can match its tool result. OpenAI function-calling shape.
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string; // present on a role:'tool' result message
}

export interface ChatOptions {
  endpoint: string;
  model: string;
  apiKey?: string | null;
  message?: string;             // single-turn convenience
  messages?: ChatMessage[];     // full conversation (takes precedence)
  tools?: unknown[];            // OpenAI tool/function definitions (optional)
  timeoutMs?: number;
  // Extra request headers. Used to carry X-Hermes-Session-Id so a local Hermes
  // gateway keeps every turn in ONE session instead of deriving a fresh one per
  // request (unknown to other harnesses, which ignore it).
  headers?: Record<string, string>;
}

// Handle returned by streamChat so a caller can abort an in-flight request
// (e.g. the user barges in with the wake word and we must stop generating).
export interface ChatHandle {
  cancel: () => void;
}

/**
 * Pure SSE chat streamer for OpenAI-compatible /chat/completions endpoints.
 * No Electron dependency — unit-testable against a mock HTTP server.
 *
 * Returns a ChatHandle whose cancel() aborts the request and silences any
 * further callbacks — used for barge-in (interrupt mid-reply).
 */
export function streamChat(opts: ChatOptions, callbacks: LlmCallbacks): ChatHandle {
  const { endpoint, model, apiKey, message, messages, tools, timeoutMs = 30000, headers: extraHeaders } = opts;

  // Once cancelled we destroy the socket AND swallow any late callbacks, so an
  // aborted reply never reaches the renderer (no stray tokens after barge-in).
  let cancelled = false;
  let req: http.ClientRequest | null = null;
  const handle: ChatHandle = {
    cancel: () => {
      cancelled = true;
      if (req) { try { req.destroy(); } catch { /* already gone */ } }
    },
  };
  const cb: LlmCallbacks = {
    onToken: (t) => { if (!cancelled) callbacks.onToken(t); },
    onDone: (f) => { if (!cancelled) callbacks.onDone(f); },
    onError: (e) => { if (!cancelled) callbacks.onError(e); },
    onTool: (info) => { if (!cancelled) callbacks.onTool?.(info); },
    onToolCalls: (calls) => { if (!cancelled) callbacks.onToolCalls?.(calls); },
  };
  // Accumulate streamed tool calls (id/name arrive once, arguments fragment
  // across many deltas) keyed by their stream index, for callers that execute
  // them (the direct-LLM delegate path).
  const toolAcc = new Map<number, ToolCall>();
  // A tool's name streams once but its argument fragments arrive across many
  // deltas — track keys so each distinct tool call is reported to the UI once.
  const seenTools = new Set<string>();

  if (!endpoint) {
    cb.onError('No LLM endpoint configured. Go to Settings to add one.');
    return handle;
  }

  const chatMessages: ChatMessage[] =
    messages && messages.length ? messages : [{ role: 'user', content: message ?? '' }];

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    cb.onError(`Invalid LLM endpoint URL: ${endpoint}`);
    return handle;
  }

  // Normalize a base URL to the OpenAI chat route so users can paste whatever
  // their local server documents — the full "…/v1/chat/completions", just the
  // host ("http://127.0.0.1:8642"), or the "…/v1" base that Ollama/LM Studio/
  // vLLM advertise. Without this a POST to "/" or "/v1" 404s, which (not being a
  // connection error) silently fell back to the other target.
  const basePath = url.pathname.replace(/\/+$/, ''); // drop trailing slash(es)
  if (basePath === '') {
    url.pathname = '/v1/chat/completions';            // host only
  } else if (/\/v\d+$/.test(basePath)) {
    url.pathname = basePath + '/chat/completions';    // "…/v1" base
  } else {
    url.pathname = basePath;                          // full/custom path, left as-is
  }

  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const body = JSON.stringify({
    model,
    messages: chatMessages,
    stream: true,
    ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
  });

  req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      // Reuse a warm keep-alive socket instead of handshaking per request.
      agent: isHttps ? httpsAgent : httpAgent,
      headers: {
        'Content-Type': 'application/json',
        // Advertise SSE so OpenAI-compatible servers/proxies stream the response
        // incrementally instead of buffering the whole thing and sending it at
        // the end. Without this some proxies (e.g. nginx-fronted gateways) hold
        // the full reply, which silently degrades streaming into a long
        // wait-for-everything — a real "large response delay even with a direct
        // provider" cause that no app-side change other than this header fixes.
        Accept: 'text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(extraHeaders || {}),
      },
    },
    (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        let errBody = '';
        res.on('data', (chunk) => { errBody += chunk; });
        res.on('end', () => {
          cb.onError(`LLM returned ${res.statusCode}: ${errBody.slice(0, 200)}`);
        });
        return;
      }

      let fullText = '';
      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        if (cancelled) return;
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trimStart();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload);
            // Surface any tool the harness invoked (once per distinct call).
            for (const tool of extractTools(parsed)) {
              if (!seenTools.has(tool.key)) {
                seenTools.add(tool.key);
                cb.onTool?.({ name: tool.name, args: tool.args });
              }
            }
            // Accumulate any tool-call fragments (for the delegate path). id +
            // name arrive in the first delta of a call; argument text streams
            // across later deltas — concatenate by stream index.
            const tcs = parsed.choices?.[0]?.delta?.tool_calls;
            if (Array.isArray(tcs)) {
              for (const tc of tcs) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                const cur = toolAcc.get(idx) || { id: '', name: '', arguments: '' };
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name = tc.function.name;
                if (tc.function?.arguments) cur.arguments += tc.function.arguments;
                toolAcc.set(idx, cur);
              }
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              cb.onToken(delta);
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      });

      res.on('end', () => {
        // If the model finished by requesting tool calls and the caller wants to
        // execute them, hand them over INSTEAD of ending the turn. Otherwise end
        // normally (the harness path, or a plain text answer).
        const calls = Array.from(toolAcc.values()).filter((c) => c.name);
        if (calls.length && callbacks.onToolCalls) {
          cb.onToolCalls?.(calls);
        } else {
          cb.onDone(fullText);
        }
      });
    },
  );

  // Disable Nagle so the request body (and the server's first SSE bytes) aren't
  // held back by TCP coalescing — shaves a little more off time-to-first-token.
  req.on('socket', (socket) => { try { socket.setNoDelay(true); } catch { /* best effort */ } });

  req.on('error', (err) => {
    // A cancel() destroy() also surfaces here as ECONNRESET/aborted — cb guards
    // it so a deliberate barge-in isn't reported to the user as a failure.
    cb.onError(`LLM connection failed: ${err.message}. Check endpoint and network.`);
  });

  req.setTimeout(timeoutMs, () => {
    req!.destroy();
    cb.onError(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s.`);
  });

  req.write(body);
  req.end();
  return handle;
}
