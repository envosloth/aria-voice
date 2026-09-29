// Read credentials at spawn/restart, never write them into the parent env.
export const CLOUD_TTS = ['elevenlabs', 'cartesia', 'openai', 'deepgram'] as const;
export function sttSecret(provider: string): string | null {
  if (provider === 'groq') return 'stt-api-key'; // retain existing installations
  if (provider === 'deepgram' || provider === 'assemblyai') return `stt-${provider}-api-key`;
  return null;
}
export function ttsSecret(engine: string): string | null {
  return CLOUD_TTS.some(p => p === engine) ? `tts-${engine}-api-key` : null;
}
type Read = (key: string) => unknown;
type Secret = (key: string) => string | null;
function safeSecret(read: Secret, key: string): string {
  try { return read(key) || ''; } catch { return ''; }
}
export function sttEnvironment(get: Read, secret: Secret): NodeJS.ProcessEnv {
  const selected = String(get('stt.provider') || 'local');
  const alias = sttSecret(selected);
  const env: NodeJS.ProcessEnv = { ARIA_STT_PROVIDER: alias ? selected : 'local', ARIA_STT_GROQ_MODEL: String(get('stt.groqModel') || 'whisper-large-v3-turbo') };
  if (alias) env[selected === 'groq' ? 'ARIA_STT_GROQ_KEY' : 'ARIA_STT_CLOUD_KEY'] = safeSecret(secret, alias);
  return env;
}
export function ttsEnvironment(get: Read, secret: Secret): NodeJS.ProcessEnv {
  const engine = String(get('tts.engine') || 'kokoro');
  const alias = ttsSecret(engine);
  if (!alias) return {};
  return {
    ARIA_TTS_CLOUD_KEY: safeSecret(secret, alias),
    ARIA_TTS_CLOUD_MODEL: String(get(`tts.cloudModels.${engine}`) || ''),
    ARIA_TTS_CLOUD_VOICE: String(get(`tts.cloudVoices.${engine}`) || ''),
  };
}
