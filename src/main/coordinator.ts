import { config } from './config';
import { getSecret } from './secure-storage';
import { streamChat, LlmCallbacks } from './llm-stream';
import { route, Target } from './router';

export interface CoordinatorCallbacks extends LlmCallbacks {
  onRoute?: (info: { target: Target; name: string }) => void;
}

const TARGET_NAMES: Record<Target, string> = { llm: 'LLM', harness: 'Agent' };

/**
 * Route a user message to the conversational LLM or the agent harness, then
 * stream the reply. Routing is automatic by default (intent heuristic) but can
 * be forced via config.routing.mode.
 */
export async function coordinate(userMessage: string, cb: CoordinatorCallbacks): Promise<void> {
  const llmEndpoint = config.get('llm.endpoint') as string;
  const harnessEndpoint = config.get('harness.endpoint') as string;
  const mode = (config.get('routing.mode') as 'auto' | 'llm' | 'harness') || 'auto';

  const target = route(userMessage, {
    mode,
    hasLlm: !!llmEndpoint,
    hasHarness: !!harnessEndpoint,
  });

  const endpoint = target === 'harness' ? harnessEndpoint : llmEndpoint;
  const model = (target === 'harness' ? config.get('harness.model') : config.get('llm.model')) as string;
  const apiKey = await getSecret(target === 'harness' ? 'harness-api-key' : 'llm-api-key');

  if (!endpoint) {
    cb.onError(
      `No ${target === 'harness' ? 'agent harness' : 'conversational LLM'} configured. ` +
      'Open Settings to add one.',
    );
    return;
  }

  cb.onRoute?.({ target, name: TARGET_NAMES[target] });
  streamChat({ endpoint, model, apiKey, message: userMessage }, cb);
}
