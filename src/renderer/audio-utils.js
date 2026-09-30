// Audio format helpers for the mic capture path. Pure functions so they can be
// unit-tested in Node and loaded directly in the renderer (no bundler).
//
// The mic delivers Float32 samples at the AudioContext rate (commonly 48000 Hz).
// The STT/wake-word sidecars expect 16000 Hz mono signed-16-bit PCM. These
// helpers downsample with an interval-average anti-alias filter and convert.

(function (root) {
  const TARGET_RATE = 16000;

  // Downsample a Float32 mono buffer to 16 kHz. Each output sample is the
  // weighted average of its source interval, so energy above the 8 kHz target
  // Nyquist limit is attenuated instead of aliased into Whisper's speech band.
  // This is frame-local and adds no buffering latency.
  function downsampleTo16k(float32, sourceRate) {
    if (sourceRate === TARGET_RATE) return float32;
    if (sourceRate < TARGET_RATE) {
      throw new Error(`source rate ${sourceRate} below target ${TARGET_RATE}`);
    }
    const ratio = sourceRate / TARGET_RATE;
    const outLength = Math.floor(float32.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const start = i * ratio;
      const end = start + ratio;
      let sum = 0;
      for (let j = Math.floor(start); j < Math.ceil(end) && j < float32.length; j++) {
        const weight = Math.min(end, j + 1) - Math.max(start, j);
        if (weight > 0) sum += float32[j] * weight;
      }
      out[i] = sum / ratio;
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
  // and then sustained silence followed. `hangMs` is the normal trailing-silence
  // delay. `shortSpeechHangMs` is a longer delay granted only while the
  // cumulative qualified speech lies in [shortSpeechMinMs, shortSpeechMaxMs]:
  // a brief opening fragment ("I'm…", "can you…") gets thinking time, while a
  // completed request (more speech) and a lone cough/click (less than the
  // floor) both end on the normal hang. Decoupled from timers so it can be
  // unit-tested deterministically.
  //
  // Noise hardening (the conversation-mode "picks up background noise" fix):
  // (1) `minSpeechMs` — energy must stay above the gate for this long
  //     CONSECUTIVELY before it counts as speech, so a door slam, key click, or
  //     cough transient can't open a turn on its own.
  // (2) `seedFloor` + adaptive noise floor — low-level frames seed an ambient
  //     noise estimate (an EMA updated by every below-gate frame), and the
  //     effective gate is max(threshold, noiseFloor * 3). Never seed from a
  //     loud first frame: a user can begin speaking immediately when a
  //     follow-up window opens, and treating that speech as the floor would
  //     make the gate too high for the entire turn. A room with a fan, music,
  //     or street noise reads as silence unless the user speaks OVER it.
  // ponytail: energy-only. Steady noise as LOUD as speech (TV dialogue at desk
  // volume) still reads as speech — renderer-side Silero VAD if that matters.
  function VadEndpointer(opts) {
    opts = opts || {};
    const threshold = opts.threshold != null ? opts.threshold : 0.012;
    const hangMs = opts.hangMs != null ? opts.hangMs : 800;
    const shortSpeechMaxMs = opts.shortSpeechMaxMs != null ? Math.max(0, opts.shortSpeechMaxMs) : 0;
    const shortSpeechHangMs = opts.shortSpeechHangMs != null
      ? Math.max(hangMs, opts.shortSpeechHangMs)
      : hangMs;
    const shortSpeechMinMs = opts.shortSpeechMinMs != null ? Math.max(0, opts.shortSpeechMinMs) : 0;
    const frameMs = opts.frameMs != null ? opts.frameMs : 20;
    const minSpeechMs = opts.minSpeechMs != null ? opts.minSpeechMs : 40;
    const seedFloor = !!opts.seedFloor;
    // Only low-level frames may establish a follow-up's baseline. This keeps
    // immediate speech from poisoning the floor while adapting to typical room
    // ambience (the follow-up caller can tune it for unusual microphones).
    const floorCaptureMax = opts.floorCaptureMax != null ? opts.floorCaptureMax : 0.06;
    let sawSpeech = false;
    let speechMs = 0;   // consecutive above-gate ms (resets on any quiet frame)
    let totalSpeechMs = 0;
    let silenceMs = 0;
    let ended = false;
    let noiseFloor = seedFloor ? 0 : -1; // ambient RMS estimate
    // Speculative early end: `epoch` counts speech segments (bumped whenever
    // speech resumes after a pause), so a transcript of the audio-so-far is
    // tied to the exact pause it was taken in. allowEarlyEnd(epoch, ms) lowers
    // this pause's hang only if no speech has arrived since; any new word voids
    // the grant and the normal hang applies again.
    let epoch = 0;
    let earlyHangMs = 0;

    // Returns true exactly once, on the frame that ends the utterance.
    this.pushRms = function (frameRms) {
      if (ended) return false;
      if (noiseFloor < 0) noiseFloor = 0;
      // A quiet first frame must still be allowed to raise the gate before it
      // accumulates minSpeechMs. Conversely, loud first-frame speech must not
      // raise the gate at all; it should qualify against the base threshold.
      if (seedFloor && frameRms <= floorCaptureMax) {
        noiseFloor = noiseFloor * 0.95 + frameRms * 0.05;
      }
      const gate = Math.max(threshold, noiseFloor * 3);
      if (frameRms >= gate) {
        speechMs += frameMs;
        if (!sawSpeech && speechMs >= minSpeechMs) {
          sawSpeech = true;
          totalSpeechMs = speechMs;
        } else if (sawSpeech) {
          totalSpeechMs += frameMs;
        }
        // Once an utterance is qualified, every above-gate frame is speech. Do
        // not make a resumed speaker re-qualify before clearing a brief pause:
        // follow-up turns need 240ms to open, but a mid-sentence word after a
        // pause must reset the endpoint timer immediately.
        if (sawSpeech) {
          if (silenceMs > 0) { epoch++; earlyHangMs = 0; }
          silenceMs = 0;
        }
      } else {
        speechMs = 0;
        if (!seedFloor) noiseFloor = noiseFloor * 0.95 + frameRms * 0.05;
        if (sawSpeech) {
          silenceMs += frameMs;
          const activeHangMs = shortSpeechMaxMs > 0
            && totalSpeechMs >= shortSpeechMinMs && totalSpeechMs <= shortSpeechMaxMs
            ? shortSpeechHangMs
            : hangMs;
          const effectiveHangMs = earlyHangMs > 0 ? Math.min(earlyHangMs, activeHangMs) : activeHangMs;
          if (silenceMs >= effectiveHangMs) {
            ended = true;
            return true;
          }
        }
      }
      return false;
    };
    this.pushFrame = function (float32) { return this.pushRms(rms(float32)); };
    this.reset = function () { sawSpeech = false; speechMs = 0; totalSpeechMs = 0; silenceMs = 0; ended = false; noiseFloor = seedFloor ? 0 : -1; epoch = 0; earlyHangMs = 0; };
    this.hasSpeech = function () { return sawSpeech; };
    // Trailing silence of the current pause (0 while speaking / before speech).
    this.pauseMs = function () { return sawSpeech ? silenceMs : 0; };
    this.speechEpoch = function () { return epoch; };
    this.speechMs = function () { return sawSpeech ? totalSpeechMs : 0; };
    // Returns true when the grant applies to the pause that is still ongoing.
    this.allowEarlyEnd = function (forEpoch, ms) {
      if (ended || !sawSpeech || forEpoch !== epoch || silenceMs <= 0 || !(ms > 0)) return false;
      earlyHangMs = ms;
      return true;
    };
  }

  // Clean a piece of assistant text so it reads naturally aloud. LLM replies are
  // full of things that sound like gibberish when spoken verbatim: markdown
  // emphasis (*, _, `, #), bullet/heading marks, raw URLs (read out
  // character-by-character), code blocks, table pipes, and emoji. We strip the
  // markup but KEEP the words, turn links/emails into a short spoken placeholder,
  // and drop code blocks. The on-screen transcript still shows the raw text —
  // this only affects what TTS receives. Returns '' if nothing speakable is left.
  // ElevenLabs v3/v4 expressive audio tags ("[laughs]"). Mirrors
  // src/main/audio-tags.ts; only these models act on them, others would read
  // them aloud, so speech, display and prompt all share one predicate.
  const EXPRESSIVE_MODEL = /^eleven_v(?:3|4)(?:_|$)/;
  const AUDIO_TAG = /\[[A-Za-z][A-Za-z ,'-]{0,40}\]/g;
  const OPEN_AUDIO_TAG = /\[[A-Za-z][A-Za-z ,'-]{0,40}$/;
  function audioTagsActive(engine, model, enabled) {
    return enabled !== false && engine === 'elevenlabs' && typeof model === 'string' && EXPRESSIVE_MODEL.test(model);
  }
  function tidySpaces(s) {
    return s.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?;:])/g, '$1').replace(/^ +| +$/gm, '');
  }
  // Display/transcript form: delivery directions are never shown. `partial`
  // hides a tag still streaming in ("Hello [whisp") until it closes.
  function stripAudioTags(text, opts) {
    let s = String(text || '').replace(AUDIO_TAG, ' ');
    if (opts && opts.partial) s = s.replace(OPEN_AUDIO_TAG, '');
    return tidySpaces(s).trim();
  }

  // --- Harness narration ---------------------------------------------------
  // What ARIA says aloud while its tools work, in its own first-person voice.
  // Never names agents, harnesses, models or "tools"; internal bookkeeping
  // (todo, memory, skills, clarify) stays silent. `label` is the harness's
  // human preview (the search query, the page) when it has one.
  const SILENT_TOOLS = /^(?:_|todo|memory|skill_|skills_|clarify|session_search|context_notes|tool_search|tool_describe|send_message$)/;
  const NARRATION = [
    [/web_search|search_web|^search$|google|bing/, (q) => q ? `I'll search the web for ${q}.` : "I'll search the web for that."],
    [/web_extract|fetch|read_url|scrape|crawl/, () => "I'm reading through what I found."],
    [/browser|navigate|open_url|click|screenshot_page/, () => "I'm opening the page to read it."],
    [/weather|forecast/, () => "I'm checking the forecast."],
    [/vision|screenshot|screen|image_analy/, () => "I'm taking a look at the screen."],
    [/terminal|shell|execute_code|run_command|bash|process/, () => "I'm running that on the computer now."],
    [/patch|write_file|edit_file|apply_diff/, () => "I'm making that change now."],
    [/read_file|search_files|list_dir|grep|glob/, () => "I'm looking through your files."],
    [/calendar|event/, () => "I'm checking your calendar."],
    [/mail|email|inbox/, () => "I'm checking your email."],
    [/delegate|subagent|spawn/, () => "This one has a few parts, so I'm working through them."],
    [/image_gen|generate_image|text_to_speech|tts/, () => "I'm creating that for you."],
    [/cron|schedule|reminder|timer/, () => "I'm setting that up."],
  ];
  function spokenQuery(label) {
    let q = String(label || '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!q || /https?:|www\.|[\\/]{2}|[{}<>]/.test(q)) return '';
    q = q.replace(/^["'`]+|["'`.?!]+$/g, '');
    const words = q.split(' ');
    if (words.length > 10) q = words.slice(0, 10).join(' ');
    return q.length > 90 ? '' : q;
  }
  function toolNarration(name, label) {
    const tool = String(name || '').toLowerCase().trim();
    if (!tool || SILENT_TOOLS.test(tool)) return '';
    for (const [re, say] of NARRATION) if (re.test(tool)) return say(spokenQuery(label));
    return "I'm working on the next step now.";
  }

  function sanitizeForSpeech(text, opts) {
    if (!text) return '';
    let s = String(text);
    const keepTags = !!(opts && opts.audioTags);

    // Fenced + indented code blocks: don't read code aloud at all.
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/~~~[\s\S]*?~~~/g, ' ');
    // Inline code / bold / italic / strikethrough: keep the words, drop the marks.
    s = s.replace(/`([^`]+)`/g, '$1');

    // Markdown links/images: speak the visible text, not the URL. ![alt](url) ->
    // alt; [text](url) -> text.
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    // Audio tags: protect them from the symbol strip when the engine performs
    // them, otherwise drop them whole so "[laughs]" never becomes the word.
    const tags = [];
    s = s.replace(AUDIO_TAG, (t) => keepTags ? '\uE000' + (tags.push(t) - 1) + '\uE001' : ' ');

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
    if (tags.length) s = s.replace(/\uE000(\d+)\uE001/g, (_, i) => tags[Number(i)] || '');
    return s;
  }

  // Collapse a transcript that is one phrase repeated back-to-back ("what's the
  // weather what's the weather what's the weather" -> "what's the weather").
  // whisper's decoder can loop on noisy or edge-clipped audio; the sidecar's
  // silence pad + temperature_inc=0 prevent most loops, this catches the rest
  // before the loop becomes a garbled triple-length user turn. Require at
  // least three FULL repetitions of a multi-token phrase: short emphatic
  // utterances such as "no no no no" and valid two-part patterns must never
  // be silently rewritten before they reach the user.
  function collapseRepeats(text) {
    const tokens = (text || '').trim().split(/\s+/).filter(Boolean);
    const norm = tokens.map((t) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''));
    const n = norm.length;
    if (n < 6) return tokens.join(' ');
    for (let p = 2; p * 3 <= n; p++) {
      // Do not treat a one-word emphasis (represented by any larger period)
      // as a decoder loop: "no no no no" must reach the user unchanged.
      if (new Set(norm.slice(0, p)).size < 2) continue;
      let periodic = true;
      for (let i = p; i < n; i++) {
        if (norm[i] !== norm[i - p]) { periodic = false; break; }
      }
      if (periodic) return tokens.slice(0, p).join(' ');
    }
    return tokens.join(' ');
  }

  // Turn-correlated "silent follow-up" discard state. A global "drop the next
  // result" boolean is unsafe: if follow-up A is superseded and main correctly
  // drops A's stale result, that boolean survives and discards real turn B.
  function SttDiscardGate() {
    let discardTurnId = null;
    this.begin = function () { discardTurnId = null; };
    this.markDiscard = function (turnId) { discardTurnId = turnId || null; };
    this.consume = function (turnId) {
      if (!turnId || turnId !== discardTurnId) return false;
      discardTurnId = null;
      return true;
    };
  }

  // Endpointing used for every hands-free (wake word / shortcut / follow-up)
  // turn. Shared with app.js so scripts/smoke-audio.js tests the shipped tuning.
  //   - 850ms normal trailing silence (calibration knob: shorter clips mid-pause
  //     speakers, longer feels laggy);
  //   - 1300ms when only 200–500ms of speech has been heard so far — an opening
  //     fragment followed by a hesitation. A ~1s command ("what time is it")
  //     exceeds 500ms and a cough stays under 200ms, so both use 850ms.
  const HANDSFREE_ENDPOINT_OPTS = Object.freeze({
    frameMs: 20,
    hangMs: 850,
    shortSpeechMinMs: 200,
    shortSpeechMaxMs: 500,
    shortSpeechHangMs: 1300,
  });

  // Speculative early endpointing (roadmap: low-latency voice). After
  // `speculateAfterMs` of trailing silence the renderer asks STT to transcribe
  // the audio so far; if that partial reads as a finished request
  // (looksComplete) the turn ends at `earlyHangMs` instead of the normal hang,
  // and the sidecar reuses the partial so the final pass costs ~0ms. Incomplete
  // or hesitant partials keep the normal/short-speech hang untouched.
  const SPECULATIVE_ENDPOINT_OPTS = Object.freeze({
    speculateAfterMs: 300,
    earlyHangMs: 500,
    minSpeechMs: 400,     // never speculate on a fragment this short
  });

  // Words that leave a request grammatically open when they end it.
  const OPEN_ENDINGS = new Set([
    'and', 'or', 'but', 'so', 'because', 'if', 'then', 'than', 'that', 'which', 'who',
    'to', 'at', 'in', 'on', 'of', 'for', 'from', 'with', 'about', 'into', 'onto', 'by',
    'the', 'a', 'an', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'this', 'these', 'those',
    'um', 'uh', 'er', 'erm', 'hmm', 'like', 'maybe', 'also', 'is', 'are',
    'was', 'can', 'could', 'would', 'should', 'will', 'do', 'does', 'me', 'what', 'where', 'when',
  ]);
  function looksComplete(text) {
    const raw = String(text || '').trim();
    if (!raw || /^\[[^\]]*\]$|^\([^)]*\)$/.test(raw)) return false; // [BLANK_AUDIO], (music)
    if (/(\.\.\.|…|[,;:\-–—])$/.test(raw)) return false;          // trailing-off punctuation
    const words = raw.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length < 2) return false;                            // "Hey." / "Um."
    if (OPEN_ENDINGS.has(words[words.length - 1])) return false;
    return true;
  }

  // --- Streaming TTS chunker (moved from app.js so it is unit-tested) --------
  // A sentence ends at . ! ? (+ closing quote/bracket) before whitespace/end;
  // "3.5" and "U.S." have no following space and are not split.
  const TTS_SENTENCE_END = /[.!?]+["')\]]*(?=\s|$)/g;
  // Clause boundary , ; : before whitespace ("1,000" / "12:30" do not match).
  const TTS_CLAUSE_END = /[,;:]["')\]]*(?=\s)/g;
  // Phrase boundary for a long comma-less opening sentence: the space before a
  // conjunction/preposition, once the word after it is complete. Speaking
  // "The weather in Longmont today is mostly sunny" while "with a high of…"
  // is still streaming removes the whole-sentence synth wait (BACKLOG P-TTFA).
  const TTS_PHRASE_BREAK = /\s(?=(?:with|and|but|which|because|while|so|including|although|though|for|from|until|unless|whereas)\s)/gi;
  const TTS_FIRST_WAIT_MS = 250;    // budget after the first streamed token
  const TTS_FIRST_MIN = 18;          // don't speak a fragment shorter than this
  const TTS_FIRST_MAX = 90;          // ...but don't wait past this for chunk #1
  const TTS_LATER_MAX = 220;         // hard cap for subsequent chunks
  const TTS_PHRASE_MIN_WORDS = 6;    // a phrase-split first chunk has at least this many words

  // Where to cut the next speakable chunk out of `buf`, or -1 to keep buffering.
  // `isFirst` makes chunk #1 eager so audio starts within a beat.
  // A delivery tag still streaming in ("[whisp") must travel with the words
  // it colours, so no cut may land inside or after it until it closes.
  function nextTtsCut(buf, isFirst, elapsedMs) {
    const open = OPEN_AUDIO_TAG.exec(buf);
    return cutAt(open ? buf.slice(0, open.index) : buf, isFirst, elapsedMs);
  }
  function cutAt(buf, isFirst, elapsedMs) {
    TTS_SENTENCE_END.lastIndex = 0;
    const sm = TTS_SENTENCE_END.exec(buf);
    const sentenceEnd = sm ? TTS_SENTENCE_END.lastIndex : -1;
    if (isFirst) {
      TTS_CLAUSE_END.lastIndex = 0;
      let m;
      while ((m = TTS_CLAUSE_END.exec(buf)) !== null) {
        const idx = TTS_CLAUSE_END.lastIndex;
        if (sentenceEnd > 0 && idx > sentenceEnd) break;
        if (idx >= TTS_FIRST_MIN) return idx;
      }
      if (sentenceEnd > 0) return sentenceEnd;
      TTS_PHRASE_BREAK.lastIndex = 0;
      while ((m = TTS_PHRASE_BREAK.exec(buf)) !== null) {
        const idx = m.index;
        if (idx < TTS_FIRST_MIN) continue;
        if (buf.slice(0, idx).trim().split(/\s+/).length >= TTS_PHRASE_MIN_WORDS) return idx + 1;
      }
      // A slow/stalled stream need not reach 90 characters before speech starts.
      // Only the first chunk uses this deadline; keep >=6 complete words and
      // leave open endings ("and", "the", etc.) attached to the next chunk.
      if (elapsedMs >= TTS_FIRST_WAIT_MS) {
        const words = [...buf.matchAll(/\S+\s+/g)];
        for (let i = words.length - 1; i >= TTS_PHRASE_MIN_WORDS - 1; i--) {
          const word = words[i][0].trim().toLowerCase().replace(/[^a-z0-9']/g, '');
          if (!word || OPEN_ENDINGS.has(word)) continue;
          const end = words[i].index + words[i][0].length;
          if (end >= TTS_FIRST_MIN) return end;
        }
      }
      if (buf.length >= TTS_FIRST_MAX) {
        const sp = buf.lastIndexOf(' ', TTS_FIRST_MAX);
        if (sp >= TTS_FIRST_MIN) return sp + 1;
      }
      return -1;
    }
    if (sentenceEnd > 0) return sentenceEnd;
    if (buf.length >= TTS_LATER_MAX) {
      const sp = buf.lastIndexOf(' ', TTS_LATER_MAX);
      if (sp >= 40) return sp + 1;
    }
    return -1;
  }

  // --- Echo-aware voice barge-in ------------------------------------------
  // While ARIA speaks, the mic hears ARIA too (speaker bleed that Chromium's AEC
  // may not fully cancel for WebAudio playback). Feed this detector each mic
  // frame's RMS plus the RMS ARIA is emitting at that moment (post-volume).
  //   - The reference is peak-held (~120ms) to cover output latency + reverb.
  //   - Speaker→mic coupling is learned as a running ~85th percentile of
  //     mic/reference on echo-looking frames, so ordinary echo peaks stay under
  //     the gate on loud speakers while quiet speakers do not mask the user.
  //   - Real speech over ARIA shows up as scattered frames the echo model can't
  //     explain (ARIA's syllables keep interleaving), so it fires on a vote:
  //     `votes` of the last `window` frames above the gate, not a solid run.
  // Pure + frame-driven so smoke-audio / smoke-barge-in test the shipped logic.
  function EchoAwareBargeDetector(opts) {
    opts = opts || {};
    const frameMs = opts.frameMs || 20;
    // Speech must hold 120 ms of a 200 ms window. On real speakers the echo
    // canceller leaked a 100 ms burst of ARIA's own voice, exactly the old
    // 5-frame vote; 6 frames rejects it while the user still interrupts within
    // ~160 ms (scripts/smoke-barge-in.js, ARIA_BARGE_SWEEP=1 to re-measure).
    const windowFrames = opts.window != null ? opts.window : Math.round(200 / frameMs);
    const votes = opts.votes != null ? opts.votes : Math.ceil(windowFrames * 0.6);
    // Echo reaches the mic late (output buffering + room), so the prediction
    // uses the loudest reference over this window, not just the current frame.
    const echoFrames = Math.max(1, Math.round((opts.echoWindowMs != null ? opts.echoWindowMs : 180) / frameMs));
    let refRing = [];
    const margin = opts.margin != null ? opts.margin : 1.8;
    const absFloor = opts.absFloor != null ? opts.absFloor : 0.03;
    const initCoupling = opts.initCoupling != null ? opts.initCoupling : 1.0; // assume loud until learned
    const release = opts.release != null ? opts.release : 0.8;
    const q = 0.85;
    // Until this much of ARIA's audio has been heard, only learn — never fire.
    // The learned coupling persists across replies (reset() keeps it), so this
    // costs only the first ~0.5s of the first reply on a new speaker setup.
    const warmupMs = opts.warmupMs != null ? opts.warmupMs : 500;
    let learnedMs = 0;
    let refEnv = 0;
    let coupling = initCoupling;
    let noise = 0;
    let hist = [];
    let done = false;
    this.push = function (micRms, refRms) {
      if (done) return false;
      refRing.push(refRms || 0);
      if (refRing.length > echoFrames) refRing.shift();
      let refMax = 0;
      for (let i = 0; i < refRing.length; i++) if (refRing[i] > refMax) refMax = refRing[i];
      refEnv = Math.max(refMax, refEnv * release);
      const predicted = coupling * refEnv;
      const gate = Math.max(absFloor, noise * 3, predicted * margin);
      const above = micRms > gate;
      hist.push(above ? 1 : 0);
      if (hist.length > windowFrames) hist.shift();
      let n = 0;
      for (let i = 0; i < hist.length; i++) n += hist[i];
      // A lone 40ms transient (cough/clap) can't reach the vote on its own.
      if (n >= votes && above && learnedMs >= warmupMs) { done = true; return true; }
      if (refEnv > 0.02) {
        learnedMs += frameMs;
        const ratio = micRms / refEnv;
        // Quantile tracking, excluding frames that are clearly not echo.
        if (ratio < coupling * margin * 1.5) {
          const step = 0.02 * Math.max(coupling, 0.05);
          coupling += ratio > coupling ? step * q : -step * (1 - q) * 4;
          coupling = Math.min(2, Math.max(0.05, coupling));
        }
      } else if (!above) {
        noise = noise * 0.95 + micRms * 0.05;
      }
      return false;
    };
    this.fired = function () { return done; };
    this.coupling = function () { return coupling; };
    this.reset = function () { refEnv = 0; refRing = []; hist = []; done = false; }; // keeps learned coupling/noise
  }

  // --- Voice barge-in verdict ----------------------------------------------
  // A voice barge-in only pauses ARIA; this decides what happens next from the
  // transcript of the paused moment. Silence, a whisper hallucination, or ARIA's
  // own words heard back through the speakers resume the reply. Anything else,
  // or an explicit "stop"/"wait", is a real interruption.
  const BARGE_FILLER = /^(?:you|thank you|thanks(?: for watching)?|bye|okay|ok|so|oh|ah+|uh+|um+|hm+|mm+|huh|yeah|the|and|i)$/;
  const BARGE_STOP = new Set(['stop', 'wait', 'hold', 'pause', 'sorry', 'excuse', 'actually', 'hey', 'jarvis', 'aria', 'no', 'nope', 'cancel', 'quiet', 'enough']);
  function bargeWords(text) {
    return String(text || '').toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  }
  function bargeVerdict(transcript, spoken) {
    const words = bargeWords(transcript);
    if (!words.length || BARGE_FILLER.test(words.join(' '))) return 'resume';
    const said = bargeWords(spoken);
    const saidSet = new Set(said);
    if (words.some((w) => BARGE_STOP.has(w) && !saidSet.has(w))) return 'interrupt';
    // Longest run of the transcript found verbatim, in order, in what ARIA said.
    let best = 0;
    for (let i = 0; i < words.length; i++) {
      for (let j = 0; j < said.length; j++) {
        let k = 0;
        while (i + k < words.length && j + k < said.length && words[i + k] === said[j + k]) k++;
        if (k > best) best = k;
      }
    }
    return best >= Math.max(1, Math.ceil(words.length * 0.75)) ? 'resume' : 'interrupt';
  }

  const api = {
    nextTtsCut, TTS_FIRST_WAIT_MS, EchoAwareBargeDetector, bargeVerdict,
    SPECULATIVE_ENDPOINT_OPTS, looksComplete,
    TARGET_RATE, HANDSFREE_ENDPOINT_OPTS, downsampleTo16k, floatToInt16, micFrameToPcm16k, rms, VadEndpointer,
    SttDiscardGate, sanitizeForSpeech, collapseRepeats,
    audioTagsActive, stripAudioTags, toolNarration,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node (tests)
  } else {
    root.AriaAudio = api; // browser (renderer)
  }
})(typeof self !== 'undefined' ? self : this);
