import https from 'https';
import http from 'http';
import { URL } from 'url';
import { StringDecoder } from 'string_decoder';
import { credentialedEndpointSecurityError } from './endpoint-security';

// Keep-alive connection pools, shared across every request. Without these Node
// opens a fresh TCP (and, for https providers, a full TLS) connection for every
// turn. maxSockets stays small because ARIA streams one request per target.
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8 });

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_SSE_RECORD_BYTES = 512 * 1024;
const MAX_COMPLETION_CHARS = 1_000_000;

export interface LlmCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
  // Harnesses may stream their own tool events. They are display-only here;
  // routing never depends on a conversational model requesting a tool.
  onTool?: (info: { name: string; args?: string }) => void;
  onUsage?: (usage: TokenUsage) => void;
}

export interface TokenUsage { prompt: number; completion: number; total: number; }

function extractTools(obj: unknown): { name: string; args?: string; key: string }[] {
  const out: { name: string; args?: string; key: string }[] = [];
  if (!obj || typeof obj !== 'object') return out;
  const o = obj as Record<string, any>;
  const choice = o.choices?.[0];
  const delta = choice?.delta || choice?.message || {};
  const calls = delta.tool_calls || o.tool_calls;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      const name = call?.function?.name || call?.name;
      if (name) out.push({ name, args: call?.function?.arguments, key: 'idx' + (call?.index ?? call?.id ?? name) });
    }
  }
  const functionCall = delta.function_call || o.function_call;
  if (functionCall?.name) out.push({ name: functionCall.name, args: functionCall.arguments, key: 'fc:' + functionCall.name });
  const type = o.type || o.event;
  const genericName = o.tool || o.tool_name || (type && /tool/i.test(String(type)) ? o.name : null);
  if (typeof genericName === 'string' && genericName) out.push({ name: genericName, key: 'g:' + genericName });
  return out;
}

export type MessageContent = string | Array<Record<string, unknown>>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  tool_call_id?: string;
}

export interface ChatOptions {
  endpoint: string;
  model: string;
  apiKey?: string | null;
  message?: string;
  messages?: ChatMessage[];
  timeoutMs?: number;
  // A request timeout is idle-time based; this deadline also bounds a peer that
  // keeps dribbling bytes forever.
  overallDeadlineMs?: number;
  maxResponseBytes?: number;
  maxSseRecordBytes?: number;
  maxCompletionChars?: number;
  headers?: Record<string, string>;
}

export interface ChatHandle { cancel: () => void; }

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : fallback;
}

function timeoutSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function chatUrl(rawEndpoint: string): URL | null {
  if (!rawEndpoint) return null;
  let url: URL;
  try { url = new URL(rawEndpoint); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const basePath = url.pathname.replace(/\/+$/, '');
  if (basePath === '') url.pathname = '/v1/chat/completions';
  else if (/\/v\d+$/.test(basePath)) url.pathname = basePath + '/chat/completions';
  else url.pathname = basePath;
  return url;
}

/**
 * Pure OpenAI-compatible SSE chat streamer. Every network terminal path funnels
 * through one settlement guard so late request/response events cannot duplicate
 * a callback. Caller cancellation remains intentionally silent for barge-in.
 */
export function streamChat(opts: ChatOptions, callbacks: LlmCallbacks): ChatHandle {
  const timeoutMs = positiveLimit(opts.timeoutMs, 30_000);
  const overallDeadlineMs = positiveLimit(opts.overallDeadlineMs, Math.max(120_000, timeoutMs * 4));
  const maxResponseBytes = positiveLimit(opts.maxResponseBytes, MAX_RESPONSE_BYTES);
  const maxSseRecordBytes = positiveLimit(opts.maxSseRecordBytes, MAX_SSE_RECORD_BYTES);
  const maxCompletionChars = positiveLimit(opts.maxCompletionChars, MAX_COMPLETION_CHARS);

  let cancelled = false;
  let settled = false;
  let req: http.ClientRequest | null = null;
  let response: http.IncomingMessage | null = null;
  let deadline: NodeJS.Timeout | null = null;

  const destroyTransport = () => {
    try { if (response && !response.destroyed) response.destroy(); } catch { /* already closed */ }
    try { if (req && !req.destroyed) req.destroy(); } catch { /* already closed */ }
  };
  const clearDeadline = () => { if (deadline) { clearTimeout(deadline); deadline = null; } };
  const finishError = (message: string, destroy = true) => {
    if (settled) return;
    settled = true;
    clearDeadline();
    if (destroy) destroyTransport();
    if (!cancelled) callbacks.onError(message);
  };
  const finishDone = (fullText: string, usage: TokenUsage | null) => {
    if (settled) return;
    settled = true;
    clearDeadline();
    if (!cancelled) {
      if (usage) callbacks.onUsage?.(usage);
      callbacks.onDone(fullText);
    }
  };
  const handle: ChatHandle = {
    cancel: () => {
      if (settled) return;
      cancelled = true;
      settled = true;
      clearDeadline();
      destroyTransport();
    },
  };

  if (!opts.endpoint) {
    finishError('No LLM endpoint configured. Go to Settings to add one.', false);
    return handle;
  }
  const url = chatUrl(opts.endpoint);
  if (!url) {
    finishError(`Invalid LLM endpoint URL: ${opts.endpoint}`, false);
    return handle;
  }
  const transportSecurityError = credentialedEndpointSecurityError(url, !!opts.apiKey);
  if (transportSecurityError) {
    finishError(transportSecurityError, false);
    return handle;
  }

  const chatMessages: ChatMessage[] = opts.messages && opts.messages.length
    ? opts.messages
    : [{ role: 'user', content: opts.message ?? '' }];
  const body = JSON.stringify({
    model: opts.model,
    messages: chatMessages,
    stream: true,
    stream_options: { include_usage: true },
  });
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  deadline = setTimeout(() => {
    finishError(`LLM request exceeded its overall deadline of ${timeoutSeconds(overallDeadlineMs)}s.`);
  }, overallDeadlineMs);

  try {
    req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        agent: isHttps ? httpsAgent : httpAgent,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Content-Length': Buffer.byteLength(body),
          ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          ...(opts.headers || {}),
        },
      },
      (res) => {
        response = res;
        let ended = false;
        let responseBytes = 0;
        const countChunk = (chunk: Buffer): boolean => {
          responseBytes += chunk.length;
          if (responseBytes > maxResponseBytes) {
            finishError(`LLM response exceeded the ${maxResponseBytes}-byte limit.`);
            return false;
          }
          return true;
        };
        const declaredLength = Number(res.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
          finishError(`LLM response exceeded the ${maxResponseBytes}-byte limit.`);
          return;
        }
        res.setTimeout(timeoutMs, () => {
          finishError(`LLM response timed out after ${timeoutSeconds(timeoutMs)}s.`);
        });
        res.on('aborted', () => finishError('LLM response was aborted before completion.', false));
        res.on('error', (error) => finishError(`LLM response failed: ${error.message}`, false));
        res.on('close', () => {
          if (!ended && !settled) finishError('LLM response closed before completion.', false);
        });

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          let errorBody = '';
          res.on('data', (chunk: Buffer) => {
            if (countChunk(chunk)) errorBody += chunk.toString('utf8', 0, Math.min(chunk.length, 512));
          });
          res.on('end', () => {
            ended = true;
            if (!settled) finishError(`LLM returned ${res.statusCode}: ${errorBody.slice(0, 200)}`, false);
          });
          return;
        }

        let fullText = '';
        let buffer = '';
        let usage: TokenUsage | null = null;
        const decoder = new StringDecoder('utf8');
        const seenTools = new Set<string>();

        const processRecord = (record: string) => {
          if (settled || !record) return;
          if (Buffer.byteLength(record) > maxSseRecordBytes) {
            finishError(`LLM SSE record exceeded the ${maxSseRecordBytes}-byte limit.`);
            return;
          }
          const payload = record.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();
          if (!payload || payload === '[DONE]') return;
          if (Buffer.byteLength(payload) > maxSseRecordBytes) {
            finishError(`LLM SSE record exceeded the ${maxSseRecordBytes}-byte limit.`);
            return;
          }
          try {
            const parsed = JSON.parse(payload) as Record<string, any>;
            for (const tool of extractTools(parsed)) {
              if (!seenTools.has(tool.key)) {
                seenTools.add(tool.key);
                if (!cancelled) callbacks.onTool?.({ name: tool.name, args: tool.args });
              }
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta) {
              if (fullText.length + delta.length > maxCompletionChars) {
                finishError(`LLM completion exceeded the ${maxCompletionChars}-character limit.`);
                return;
              }
              fullText += delta;
              if (!cancelled) callbacks.onToken(delta);
            }
            const rawUsage = parsed.usage;
            if (rawUsage && (rawUsage.prompt_tokens != null || rawUsage.completion_tokens != null || rawUsage.total_tokens != null)) {
              const prompt = Number(rawUsage.prompt_tokens) || 0;
              const completion = Number(rawUsage.completion_tokens) || 0;
              usage = { prompt, completion, total: Number(rawUsage.total_tokens) || prompt + completion };
            }
          } catch {
            // A malformed event is isolated; subsequent valid SSE records remain usable.
          }
        };
        const consumeRecords = (includeTrailing: boolean) => {
          while (!settled) {
            const boundary = /\r?\n\r?\n/.exec(buffer);
            if (!boundary || boundary.index == null) break;
            const record = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            processRecord(record);
          }
          if (!settled && Buffer.byteLength(buffer) > maxSseRecordBytes) {
            finishError(`LLM SSE record exceeded the ${maxSseRecordBytes}-byte limit.`);
            return;
          }
          if (!settled && includeTrailing && buffer.trim()) {
            processRecord(buffer);
            buffer = '';
          }
        };

        res.on('data', (chunk: Buffer) => {
          if (!countChunk(chunk) || settled) return;
          buffer += decoder.write(chunk);
          consumeRecords(false);
        });
        res.on('end', () => {
          ended = true;
          if (settled) return;
          buffer += decoder.end();
          consumeRecords(true);
          if (!settled) finishDone(fullText, usage);
        });
      },
    );
  } catch (error) {
    finishError(`Could not start LLM request: ${(error as Error).message}`, false);
    return handle;
  }

  req.on('socket', (socket) => { try { socket.setNoDelay(true); } catch { /* best effort */ } });
  req.on('error', (error) => {
    finishError(`LLM connection failed: ${error.message}. Check endpoint and network.`, false);
  });
  req.on('abort', () => finishError('LLM request was aborted before completion.', false));
  req.setTimeout(timeoutMs, () => {
    finishError(`LLM request timed out after ${timeoutSeconds(timeoutMs)}s.`);
  });
  req.write(body);
  req.end();
  return handle;
}
