import { config } from './config';
import { getSecret } from './secure-storage';
import { streamChat, LlmCallbacks } from './llm-stream';

export async function streamLlmResponse(userMessage: string, callbacks: LlmCallbacks): Promise<void> {
  const endpoint = config.get('llm.endpoint') as string;
  const model = config.get('llm.model') as string;
  const apiKey = await getSecret('llm-api-key');

  streamChat({ endpoint, model, apiKey, message: userMessage }, callbacks);
}
