// ElevenLabs v3/v4 expressive audio tags ("[laughs]", "[whispers]").
// Only these models interpret bracketed delivery directions; every other engine
// would read them aloud, so the prompt, speech text and transcript all gate on
// the same predicate (mirrored in renderer/audio-utils.js).
const EXPRESSIVE_MODEL = /^eleven_v(?:3|4)(?:_|$)/;
// A tag starts with a letter and stays short; numeric citations like [1] and
// Markdown links (already rewritten upstream) are never tags.
export const AUDIO_TAG = /\[[A-Za-z][A-Za-z ,'-]{0,40}\]/g;

export function audioTagsActive(engine: unknown, model: unknown, enabled: unknown): boolean {
  return enabled !== false && engine === 'elevenlabs' && typeof model === 'string' && EXPRESSIVE_MODEL.test(model);
}

export function stripAudioTags(text: string): string {
  return String(text || '').replace(AUDIO_TAG, ' ').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?;:])/g, '$1').replace(/^ +| +$/gm, '');
}

export function expressivePrompt(engine: unknown, model: unknown, enabled: unknown): string {
  if (!audioTagsActive(engine, model, enabled)) return '';
  return '\n\nExpressive delivery: your voice supports audio tags in square brackets that ' +
    'direct HOW a line is spoken and are never read aloud, e.g. [laughs], [chuckles], ' +
    '[sighs], [whispers], [excited], [curious], [sarcastic], [warmly], [softly]. Place a tag ' +
    'immediately before the words it colours. Use them sparingly and only when they fit ' +
    'the moment: at most one or two per reply, none in plain factual answers. Do not use ' +
    'sound effect tags (applause, gunshot, explosion) or singing, and never explain or ' +
    'mention the tags. Ellipses add a pause; CAPITALS add emphasis.';
}
