// "Test" button in Settings → Performance: measure time to first audio with the
// real pipeline, without touching the conversation.
//
//   1. The voice speaks a known phrase (TTS) — its PCM becomes the test's
//      "user speech", resampled to the mic format (16 kHz s16le).
//   2. That audio goes through the real STT sidecar; the clock starts when the
//      transcribe request is sent (= the moment you stop talking).
//   3. The transcript goes to the configured AI (direct LLM if set, else the
//      agent harness) as a one-off request — no history, no saved session.
//   4. The reply's first speakable phrase is synthesized; the clock stops at
//      its first audio chunk.
//
// The orchestration is dependency-injected so it can be verified without
// sidecars or a network (scripts/smoke-latency-test.js).

export const TEST_PHRASE = 'Hello ARIA, please greet me in one short sentence.';

export interface LatencyTestDeps {
  /** Synthesize `text`; resolves with every PCM chunk plus when the first one arrived. */
  synthesize(text: string, replyId: string): Promise<{ chunks: Buffer[]; sampleRate: number; firstChunkAt: number; requestedAt: number }>;
  /** Run STT over 16 kHz s16le PCM. `onSent` fires when transcribe is requested. */
  transcribe(pcm16k: Buffer, turnId: string, onSent: (t: number) => void): Promise<string>;
  /** Stream one reply; call onToken per token; resolves with the full text. */
  chat(text: string, onToken: (token: string) => void, signal: { cancelled: boolean }): Promise<{ target: string; text: string }>;
  now(): number;
}

export interface LatencyTestResult {
  ok: boolean;
  error?: string;
  transcript?: string;
  reply?: string;
  target?: string;
  sttMs?: number;        // end of speech -> transcript
  llmMs?: number;        // request sent -> first speakable phrase ready
  ttsMs?: number;        // phrase sent to the voice -> first audio chunk
  firstAudioMs?: number; // end of speech -> first audio chunk (what you feel)
}

// Mirrors the renderer's first-chunk rule (app.js nextTtsCut, isFirst): speak at
// the first clause/sentence boundary once there are >= 18 chars, else wait for
// up to 90 chars and cut at a word boundary.
const FIRST_MIN = 18;
const FIRST_MAX = 90;
export function firstSpeakable(buf: string): string | null {
  const re = /[,;:—–]\s|[.!?](\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    const idx = re.lastIndex;
    if (idx >= FIRST_MIN) return buf.slice(0, idx).trim();
  }
  if (buf.length >= FIRST_MAX) {
    const sp = buf.lastIndexOf(' ', FIRST_MAX);
    if (sp >= FIRST_MIN) return buf.slice(0, sp).trim();
  }
  return null;
}

/** Linear-resample s16le mono PCM to 16 kHz. */
export function toMono16k(chunks: Buffer[], sampleRate: number): Buffer {
  const src = Buffer.concat(chunks);
  const n = Math.floor(src.length / 2);
  if (!n) return Buffer.alloc(0);
  const ratio = sampleRate / 16000;
  const outN = Math.floor(n / ratio);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    const b = Math.min(n - 1, a + 1);
    const f = pos - a;
    const v = src.readInt16LE(a * 2) * (1 - f) + src.readInt16LE(b * 2) * f;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); }),
  ]);
}

export async function runLatencyTest(deps: LatencyTestDeps, id: string): Promise<LatencyTestResult> {
  try {
    // 1. Make the test "speech" with the voice itself.
    const speech = await withTimeout(deps.synthesize(TEST_PHRASE, `${id}:speech`), 30_000, 'Preparing the test audio');
    const pcm = toMono16k(speech.chunks, speech.sampleRate);
    if (pcm.length < 16000) return { ok: false, error: 'The voice produced no test audio.' };

    // 2. Speech-to-text, clock starts at "end of speech".
    let t0 = 0;
    const transcript = (await withTimeout(deps.transcribe(pcm, `${id}:stt`, (t) => { t0 = t; }), 30_000, 'Speech recognition')).trim();
    const tStt = deps.now();
    if (!transcript) return { ok: false, error: 'Speech recognition returned nothing for the test phrase.' };

    // 3. AI reply until the first speakable phrase.
    const tChat = deps.now();
    let buf = '';
    let phrase: string | null = null;
    let tPhrase = 0;
    const signal = { cancelled: false };
    let resolvePhrase: () => void = () => {};
    const phraseReady = new Promise<void>((r) => { resolvePhrase = r; });
    const chatP = deps.chat(transcript, (tok) => {
      if (phrase) return;
      buf += tok;
      const p = firstSpeakable(buf);
      if (p) { phrase = p; tPhrase = deps.now(); resolvePhrase(); }
    }, signal);
    chatP.catch(() => {}); // observed below; avoid an unhandled rejection meanwhile
    // Like the real app, start speaking as soon as the first phrase is ready —
    // don't wait for the whole reply.
    let early: { target: string; text: string } | null = null;
    try {
      early = await withTimeout(Promise.race([phraseReady.then(() => null), chatP]), 60_000, 'The AI');
    } catch (e) { signal.cancelled = true; throw e; }
    if (!phrase) { phrase = (early ? early.text : '').trim(); tPhrase = deps.now(); }
    if (!phrase) return { ok: false, error: 'The AI replied with nothing to say.', transcript, target: early ? early.target : undefined };
    const phraseText: string = phrase;

    // 4. First audio of the reply.
    const voice = await withTimeout(deps.synthesize(phraseText, `${id}:reply`), 30_000, 'The voice');
    const reply = early || await withTimeout(chatP, 60_000, 'The AI').catch(() => ({ target: '', text: phraseText }));
    return {
      ok: true,
      transcript,
      reply: reply.text.trim(),
      target: reply.target,
      sttMs: Math.round(tStt - t0),
      llmMs: Math.round(tPhrase - tChat),
      ttsMs: Math.round(voice.firstChunkAt - voice.requestedAt),
      firstAudioMs: Math.round(voice.firstChunkAt - t0),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message || String(e) };
  }
}
