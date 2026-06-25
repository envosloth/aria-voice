import { config } from './config';
import { getSecret } from './secure-storage';
import { streamChat, LlmCallbacks } from './llm-stream';
import { route, Target } from './router';

export interface CoordinatorCallbacks extends LlmCallbacks {
  onRoute?: (info: { target: Target; name: string }) => void;
}

const TARGET_NAMES: Record<Target, string> = { llm: 'LLM', harness: 'Agent' };

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

/**
 * Route a user message to the conversational LLM or the agent harness, then
 * stream the reply. If the chosen target is unreachable, automatically falls
 * back to the other configured target before surfacing an error.
 */
export async function coordinate(userMessage: string, cb: CoordinatorCallbacks): Promise<void> {
  const llmEndpoint = config.get('llm.endpoint') as string;
  const harnessEndpoint = config.get('harness.endpoint') as string;
  const mode = (config.get('routing.mode') as 'auto' | 'llm' | 'harness') || 'auto';
  const hasLlm = !!llmEndpoint;
  const hasHarness = !!harnessEndpoint;

  if (!hasLlm && !hasHarness) {
    cb.onError('No LLM or agent harness configured yet. Open Settings (gear icon) to add one.');
    return;
  }

  const primary = route(userMessage, { mode, hasLlm, hasHarness });
  const fallback: Target | null =
    primary === 'harness' && hasLlm ? 'llm' :
    primary === 'llm' && hasHarness ? 'harness' : null;

  const run = async (target: Target, isFallback: boolean) => {
    const { endpoint, model, apiKeyName } = await resolve(target);
    const apiKey = await getSecret(apiKeyName);
    cb.onRoute?.({ target, name: TARGET_NAMES[target] + (isFallback ? ' (fallback)' : '') });

    streamChat({ endpoint, model, apiKey, message: userMessage }, {
      onToken: cb.onToken,
      onDone: cb.onDone,
      onError: (err) => {
        // On a connection failure, try the other configured target once.
        if (!isFallback && fallback && isConnectionError(err)) {
          void run(fallback, true);
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

  await run(primary, false);
}
