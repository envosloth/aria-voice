import https from 'https';
import http from 'http';
import { URL } from 'url';

export interface LlmCallbacks {
  onToken: (token: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

// content is a string for normal turns, or an OpenAI-vision content array
// (text + image_url parts) when a screen-share frame is attached.
export type MessageContent = string | Array<Record<string, unknown>>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

export interface ChatOptions {
  endpoint: string;
  model: string;
  apiKey?: string | null;
  message?: string;             // single-turn convenience
  messages?: ChatMessage[];     // full conversation (takes precedence)
  timeoutMs?: number;
}

/**
 * Pure SSE chat streamer for OpenAI-compatible /chat/completions endpoints.
 * No Electron dependency — unit-testable against a mock HTTP server.
 */
export function streamChat(opts: ChatOptions, callbacks: LlmCallbacks): void {
  const { endpoint, model, apiKey, message, messages, timeoutMs = 30000 } = opts;

  if (!endpoint) {
    callbacks.onError('No LLM endpoint configured. Go to Settings to add one.');
    return;
  }

  const chatMessages: ChatMessage[] =
    messages && messages.length ? messages : [{ role: 'user', content: message ?? '' }];

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    callbacks.onError(`Invalid LLM endpoint URL: ${endpoint}`);
    return;
  }

  // If only a base URL was entered (host:port with no API path), assume the
  // conventional OpenAI route so "http://127.0.0.1:8642" works the same as the
  // full "http://127.0.0.1:8642/v1/chat/completions". Without this a POST to "/"
  // 404s, which (not being a connection error) silently fell back to the LLM.
  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/v1/chat/completions';
  }

  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const body = JSON.stringify({
    model,
    messages: chatMessages,
    stream: true,
  });

  const req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    },
    (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        let errBody = '';
        res.on('data', (chunk) => { errBody += chunk; });
        res.on('end', () => {
          callbacks.onError(`LLM returned ${res.statusCode}: ${errBody.slice(0, 200)}`);
        });
        return;
      }

      let fullText = '';
      let buffer = '';

      res.on('data', (chunk: Buffer) => {
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
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              callbacks.onToken(delta);
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      });

      res.on('end', () => {
        callbacks.onDone(fullText);
      });
    },
  );

  req.on('error', (err) => {
    callbacks.onError(`LLM connection failed: ${err.message}. Check endpoint and network.`);
  });

  req.setTimeout(timeoutMs, () => {
    req.destroy();
    callbacks.onError(`LLM request timed out after ${Math.round(timeoutMs / 1000)}s.`);
  });

  req.write(body);
  req.end();
}
