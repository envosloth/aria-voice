// Audio format helpers for the mic capture path. Pure functions so they can be
// unit-tested in Node and loaded directly in the renderer (no bundler).
//
// The mic delivers Float32 samples at the AudioContext rate (commonly 48000 Hz).
// The STT/wake-word sidecars expect 16000 Hz mono signed-16-bit PCM. These
// helpers downsample (linear interpolation — adequate for speech) and convert.

(function (root) {
  const TARGET_RATE = 16000;

  // Downsample a Float32 mono buffer from sourceRate to 16000 Hz via linear
  // interpolation. Returns a Float32Array at the target rate.
  function downsampleTo16k(float32, sourceRate) {
    if (sourceRate === TARGET_RATE) return float32;
    if (sourceRate < TARGET_RATE) {
      throw new Error(`source rate ${sourceRate} below target ${TARGET_RATE}`);
    }
    const ratio = sourceRate / TARGET_RATE;
    const outLength = Math.floor(float32.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcPos = i * ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, float32.length - 1);
      const frac = srcPos - i0;
      out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
    }
    return out;
  }

  // Convert a Float32 buffer in [-1, 1] to signed 16-bit PCM (little-endian),
  // returned as an ArrayBuffer ready to ship over IPC.
  function floatToInt16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = float32[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  // Full pipeline: Float32 @ sourceRate -> Int16 PCM ArrayBuffer @ 16kHz.
  function micFrameToPcm16k(float32, sourceRate) {
    return floatToInt16(downsampleTo16k(float32, sourceRate));
  }

  // Root-mean-square energy of a Float32 frame (0..~1).
  function rms(float32) {
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    return Math.sqrt(sum / float32.length);
  }

  // Energy-based endpointer for hands-free turns. Feed it per-frame RMS (or
  // raw frames); it reports when an utterance has ended — i.e. speech was seen
  // and then `hangMs` of sustained silence followed. Decoupled from timers so
  // it can be unit-tested deterministically.
  function VadEndpointer(opts) {
    opts = opts || {};
    const threshold = opts.threshold != null ? opts.threshold : 0.012;
    const hangMs = opts.hangMs != null ? opts.hangMs : 800;
    const frameMs = opts.frameMs != null ? opts.frameMs : 20;
    let sawSpeech = false;
    let silenceMs = 0;
    let ended = false;

    // Returns true exactly once, on the frame that ends the utterance.
    this.pushRms = function (frameRms) {
      if (ended) return false;
      if (frameRms >= threshold) {
        sawSpeech = true;
        silenceMs = 0;
      } else if (sawSpeech) {
        silenceMs += frameMs;
        if (silenceMs >= hangMs) {
          ended = true;
          return true;
        }
      }
      return false;
    };
    this.pushFrame = function (float32) { return this.pushRms(rms(float32)); };
    this.reset = function () { sawSpeech = false; silenceMs = 0; ended = false; };
    this.hasSpeech = function () { return sawSpeech; };
  }

  // Clean a piece of assistant text so it reads naturally aloud. LLM replies are
  // full of things that sound like gibberish when spoken verbatim: markdown
  // emphasis (*, _, `, #), bullet/heading marks, raw URLs (read out
  // character-by-character), code blocks, table pipes, and emoji. We strip the
  // markup but KEEP the words, turn links/emails into a short spoken placeholder,
  // and drop code blocks. The on-screen transcript still shows the raw text —
  // this only affects what TTS receives. Returns '' if nothing speakable is left.
  function sanitizeForSpeech(text) {
    if (!text) return '';
    let s = String(text);

    // Fenced + indented code blocks: don't read code aloud at all.
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/~~~[\s\S]*?~~~/g, ' ');
    // Inline code / bold / italic / strikethrough: keep the words, drop the marks.
    s = s.replace(/`([^`]+)`/g, '$1');

    // Markdown links/images: speak the visible text, not the URL. ![alt](url) ->
    // alt; [text](url) -> text.
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

    // Bare URLs / emails -> short spoken placeholders (reading the raw string is
    // noise). Order matters: URLs before the generic symbol strip.
    s = s.replace(/\bhttps?:\/\/[^\s)]+/gi, ' link ');
    s = s.replace(/\bwww\.[^\s)]+/gi, ' link ');
    s = s.replace(/\b[^\s@()]+@[^\s@()]+\.[^\s@()]+\b/g, ' email address ');

    // List bullets / numbered markers / blockquote marks at line starts.
    s = s.replace(/^[ \t]*[-*+•]\s+/gm, ' ');
    s = s.replace(/^[ \t]*\d+[.)]\s+/gm, ' ');
    s = s.replace(/^[ \t]*#{1,6}\s+/gm, ' '); // ATX headings
    s = s.replace(/^[ \t]*>+\s?/gm, ' ');     // blockquotes

    // Emoji + misc pictographs/dingbats/arrows: spoken inconsistently, so drop.
    s = s.replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}️‍]/gu,
      ' ',
    );

    // Remaining structural / decorative symbols that don't read well. KEEP normal
    // sentence punctuation (. , ! ? ; : ' " - ( ) /) for natural prosody. Caret
    // (^) used to leak through and the TTS would literally read "A circumflex" or
    // "circumflex accent" on a stray character — drop it here, alongside the other
    // Markdown / shell symbols that have no useful spoken form.
    s = s.replace(/[*_~`#>|^=<>{}\[\]\\]/g, ' ');

    // Stray diacritics / Unicode symbols with no TTS-friendly pronunciation: the
    // assistant sometimes emits "^", "~", "ˆ", "ˇ", "˘", "°", "§", "¤" etc. as
    // stand-alone characters (often from leaked Markdown or shell paste). Piper /
    // Kokoro pronounce these as the symbol's NAME ("circumflex", "tilde", "degree")
    // which is meaningless out of context. Replace with a space so TTS glides over
    // them. Common Latin letter+diacritic COMBINATIONS (é, ñ, ü …) are kept — those
    // are real words, not punctuation leaks.
    s = s.replace(/[ˆˇ˘˙˚˛˜˝̣̀́̂̃̄̆̈̇̊̋̌̍̎̏ͯͯ̂͡‌‍]/g, ' ');
    s = s.replace(/[°§¤¶†‡•※©®™]/g, ' ');
    // Math + currency that read badly: keep the common ones ($, €, £, ¥) since
    // they have natural names ARIA users expect, drop the rest.
    s = s.replace(/[±×÷≈≠≤≥∞∑∏√∫∂∇πµ]/g, ' ');

    // Stray single-caret pattern: "Ctrl+^", "Cmd+^", "use ^ for …" — the caret
    // itself is dropped above but its surrounding context sometimes leaves "Ctrl+"
    // hanging, which TTS reads as "control plus". Trim a trailing "+ " left over.
    s = s.replace(/\b(ctrl|cmd|alt|shift|esc|tab|enter|return|space|backspace)\s*\+\s*$/gim, ' ');

    // SYMBOL-NAME PHRASE STRIP. The LLM sometimes explains a stray symbol in
    // its reply — "that's a circumflex", "the ^ is called a caret", "the ~
    // means tilde". TTS then reads the explanation verbatim, which is the
    // "I can hear the agent say 'A circumflex' when it don't make sense at all"
    // symptom. These names have no place in a voice reply; strip the phrase
    // entirely so the explanation disappears.
    //
    // Two layers:
    //
    // 1) ALWAYS-STRIP names — words that NEVER appear in normal English. The
    //    LLM cannot be using these for any reason other than explaining a
    //    symbol, so there's no false-positive risk. Includes "circumflex" (the
    //    user's reported bug), "umlaut", "cedilla", "macron", "breve",
    //    "caron", "ogonek", "diaeresis", "grave accent", "acute accent". The
    //    word "circumflex" on its own (with optional "a"/"the") is the
    //    canonical "A circumflex" TTS bug; removing it unconditionally is
    //    the only fully reliable fix.
    //
    // 2) CONTEXT-STRIP names — words that are common English but also have
    //    a symbol meaning. "caret" / "tilde" / "asterisk" / "hash" / "ring"
    //    / "backslash" / "slash" / "pipe" / "underscore" / "ampersand" /
    //    "pound sign". Only stripped when they sit in a definitional
    //    context: after "called/known as/named/referred to as", sandwiched
    //    between delimiters (` ' " [ < ( = ,), or "A/An/The <name> means".
    const ALWAYS_STRIP = [
      'circumflex', 'umlaut', 'cedilla', 'macron', 'breve', 'caron',
      'ogonek', 'diaeresis', 'grave accent', 'acute accent',
    ];
    // Layer 1: unconditional strip of the "a circumflex" / "the caret" / etc.
    // pattern for ALWAYS_STRIP words. The article is optional; the word
    // itself is the target. Word-boundary anchored to keep "circumflexing"
    // (if that ever existed) intact, though in practice no such word does.
    s = s.replace(
      new RegExp('\\b(?:(?:a|an|the)\\s+)?(?:' + ALWAYS_STRIP.join('|') + ')\\b', 'gi'),
      ' ',
    );
    // Layer 2: context-strip for words that have a common-English meaning.
    const CONTEXT_NAMES = [
      'caret', 'tilde', 'asterisk', 'hash mark', 'ampersand', 'backslash',
      'underscore', 'pound sign',
    ];
    // Definite verb forms: "X is called a caret", "X is known as tilde",
    // "the symbol, named caret". Verb can be followed by an optional article.
    s = s.replace(
      new RegExp('\\b(?:called|known as|named|referred to as)\\s+(?:a|an|the)?\\s*(?:' + CONTEXT_NAMES.join('|') + ')\\b', 'gi'),
      ' ',
    );
    // A symbol name sandwiched between delimiters: `(caret)` / `'caret'` /
    // `"caret"` / `[caret]` / `,caret,` / `<caret>`. A backtick is the
    // commonest case (Markdown inline code from the LLM).
    s = s.replace(
      new RegExp('([`\'"\\[<,=(])\\s*(?:' + CONTEXT_NAMES.join('|') + ')\\s*(?=[`\'"\\]>,)])', 'gi'),
      '$1',
    );
    // "A/An <symbol_name>" / "The <symbol_name>" ONLY when followed by a
    // definitional predicate (means, refers to, is the word for, is the
    // name of) — that's the literal "a caret means" grammar the LLM
    // produces. Standalone "the tilde" or "a caret" without a follow-on
    // definition is left alone (it might be a real use, e.g. the user asked
    // what something is called).
    s = s.replace(
      new RegExp('\\b(?:a|an|the)\\s+(?:' + CONTEXT_NAMES.join('|') + ')\\s+(?:means|refers to|is the (?:name|word) for|is the (?:name|word) of)\\b', 'gi'),
      ' ',
    );

    // Collapse whitespace and tidy spacing before punctuation.
    s = s.replace(/\s+([,.!?;:])/g, '$1');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  const api = {
    TARGET_RATE, downsampleTo16k, floatToInt16, micFrameToPcm16k, rms, VadEndpointer,
    sanitizeForSpeech,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node (tests)
  } else {
    root.AriaAudio = api; // browser (renderer)
  }
})(typeof self !== 'undefined' ? self : this);
