//! Piper TTS (spec §6.5): persistent voice, CPU, sanitize-before-speak (A-14).
//! Cancellation lives in the runtime's worker queue (A-7), which drops queued
//! sentences and stops feeding the sink; `stop()` here is the engine-side hook.

pub mod kokoro;

use std::path::Path;

use aria_core::{StageError, Tts};
use kokoro::KokoroTts;
use piper_rs::Piper;

/// Engine chosen by voice name: Kokoro voices are `xx_name` (af_heart,
/// bm_george…), Piper voices are `lang-name-quality` (en_GB-alan-medium).
pub enum AnyTts {
    Piper(PiperTts),
    Kokoro(KokoroTts),
}

impl AnyTts {
    pub fn load(model_dir: &Path, voice: &str, speed: f32) -> Result<Self, StageError> {
        if voice.contains('-') {
            Ok(Self::Piper(PiperTts::new(
                &model_dir.join(format!("{voice}.onnx")),
                speed,
            )?))
        } else {
            Ok(Self::Kokoro(KokoroTts::new(model_dir, voice, speed)?))
        }
    }

    pub fn sample_rate(&self) -> u32 {
        match self {
            Self::Piper(p) => {
                let r = p.sample_rate();
                if r > 0 { r } else { 22_050 }
            }
            Self::Kokoro(_) => kokoro::SAMPLE_RATE,
        }
    }
}

impl Tts for AnyTts {
    fn synth(&mut self, text: &str) -> Result<Vec<i16>, StageError> {
        match self {
            Self::Piper(p) => p.synth(text),
            Self::Kokoro(k) => {
                let clean = sanitize_for_speech(text);
                if clean.is_empty() {
                    return Ok(Vec::new());
                }
                k.synth_raw(&clean)
            }
        }
    }

    fn stop(&mut self) {}

    fn set_speed(&mut self, speed: f32) {
        match self {
            Self::Piper(p) => Tts::set_speed(p, speed),
            Self::Kokoro(k) => k.set_speed(speed),
        }
    }
}

pub struct PiperTts {
    piper: Piper,
    /// Piper "speed" is the inverse of length_scale; None = voice default.
    length_scale: Option<f32>,
    sample_rate: u32,
}

impl PiperTts {
    /// `model` is the voice `.onnx`; its `.onnx.json` config sits beside it.
    pub fn new(model: &Path, speed: f32) -> Result<Self, StageError> {
        let config = model.with_extension("onnx.json");
        let piper = Piper::new(model, &config)
            .map_err(|e| StageError::Engine(format!("piper load: {e}")))?;
        Ok(Self {
            piper,
            length_scale: ((speed - 1.0).abs() > f32::EPSILON).then_some(1.0 / speed),
            sample_rate: 0, // learned from the first synth call
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

impl Tts for PiperTts {
    fn synth(&mut self, text: &str) -> Result<Vec<i16>, StageError> {
        let clean = sanitize_for_speech(text);
        if clean.is_empty() {
            return Ok(Vec::new());
        }
        let (samples, rate) = self
            .piper
            .create(&clean, false, None, self.length_scale, None, None)
            .map_err(|e| StageError::Engine(format!("piper: {e}")))?;
        self.sample_rate = rate;
        Ok(samples
            .iter()
            .map(|&f| (f.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect())
    }

    fn stop(&mut self) {
        // Synchronous synthesis: nothing in-flight to cancel at engine level.
        // The runtime worker queue drops pending sentences (A-7).
    }

    fn set_speed(&mut self, speed: f32) {
        self.length_scale = Some(1.0 / speed.max(0.1));
    }
}

/// A-14: strip everything that reads as noise when spoken — markdown, code,
/// URLs, emoji — before synthesis.
pub fn sanitize_for_speech(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_fence = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // Headers/blockquotes/list markers → plain text.
        let stripped = trimmed
            .trim_start_matches(['#', '>'])
            .trim_start_matches(['-', '*', '+'])
            .trim_start();
        let mut cleaned = String::with_capacity(stripped.len());
        let mut chars = stripped.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                // Markdown link [text](url) → keep text.
                '[' => {
                    let label: String = chars.by_ref().take_while(|&c| c != ']').collect();
                    if chars.peek() == Some(&'(') {
                        chars.by_ref().take_while(|&c| c != ')').for_each(drop);
                    }
                    cleaned.push_str(&label);
                }
                '`' | '*' | '_' | '~' | '#' | '|' => {}
                // Emoji & symbol blocks.
                '\u{1F000}'..='\u{1FAFF}'
                | '\u{2600}'..='\u{27BF}'
                | '\u{2190}'..='\u{21FF}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{200D}' => {}
                _ => cleaned.push(c),
            }
        }
        // Drop bare URLs.
        let no_urls: String = cleaned
            .split_whitespace()
            .filter(|w| !w.starts_with("http://") && !w.starts_with("https://") && !w.starts_with("www."))
            .collect::<Vec<_>>()
            .join(" ");
        if !no_urls.is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(&no_urls);
        }
    }
    naturalize(out.trim())
}

/// Speak meaning, not glyphs: units and chat acronyms expand to words, and
/// encoding artifacts ("Â") that read as "A circumflex" are dropped.
fn naturalize(text: &str) -> String {
    // Units first (word boundaries don't apply to symbols).
    let mut s = text
        .replace('\u{00C2}', "") // mojibake artifact before ° in bad UTF-8
        .replace("°F", " degrees Fahrenheit")
        .replace("°C", " degrees Celsius")
        .replace('°', " degrees")
        .replace('%', " percent")
        .replace('&', " and ");
    // Dotted latinisms before word-pass (dots would split them).
    for (from, to) in [
        ("e.g.", "for example"),
        ("i.e.", "that is"),
        ("etc.", "et cetera"),
        ("vs.", "versus"),
    ] {
        s = case_insensitive_replace(&s, from, to);
    }
    // Word-boundary acronym expansion.
    const WORDS: &[(&str, &str)] = &[
        ("btw", "by the way"),
        ("idk", "I don't know"),
        ("fyi", "for your information"),
        ("tbh", "to be honest"),
        ("asap", "as soon as possible"),
        ("imo", "in my opinion"),
        ("iirc", "if I recall correctly"),
        ("aka", "also known as"),
        ("etc", "et cetera"),
        ("faq", "frequently asked questions"),
        ("diy", "do it yourself"),
        ("eta", "estimated arrival"),
    ];
    let mut out = String::with_capacity(s.len());
    for (i, word) in s.split_inclusive(|c: char| c.is_whitespace()).enumerate() {
        let _ = i;
        let trimmed_end: String =
            word.trim_end_matches(|c: char| c.is_whitespace() || ",.!?;:".contains(c)).to_string();
        let tail = &word[trimmed_end.len()..];
        let lower = trimmed_end.to_lowercase();
        match WORDS.iter().find(|(k, _)| *k == lower) {
            Some((_, exp)) => {
                out.push_str(exp);
                out.push_str(tail);
            }
            None => out.push_str(word),
        }
    }
    // Collapse doubled spaces introduced by replacements.
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn case_insensitive_replace(s: &str, from: &str, to: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let lower = s.to_lowercase();
    let from = from.to_lowercase();
    let mut i = 0;
    while let Some(pos) = lower[i..].find(&from) {
        let at = i + pos;
        out.push_str(&s[i..at]);
        out.push_str(to);
        i = at + from.len();
    }
    out.push_str(&s[i..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn sanitize_strips_noise() {
        assert_eq!(
            sanitize_for_speech("**Hello!** Check [docs](https://x.io) 🚀\n```rust\nlet x = 1;\n```\n- item one"),
            "Hello! Check docs item one"
        );
        assert_eq!(sanitize_for_speech("Visit https://example.com now"), "Visit now");
        assert_eq!(sanitize_for_speech("```\ncode only\n```"), "");
    }

    #[test]
    fn naturalize_speaks_meaning() {
        assert_eq!(
            sanitize_for_speech("It's 91°F outside, btw."),
            "It's 91 degrees Fahrenheit outside, by the way."
        );
        assert_eq!(
            sanitize_for_speech("Use apples, pears, etc. IDK tbh!"),
            "Use apples, pears, et cetera I don't know to be honest!"
        );
        assert_eq!(sanitize_for_speech("Â91°"), "91 degrees");
        assert_eq!(sanitize_for_speech("50% done"), "50 percent done");
        // real words that merely contain an acronym stay intact
        assert_eq!(sanitize_for_speech("the beta test"), "the beta test");
    }

    #[test]
    fn synthesizes_real_audio() {
        let voice = PathBuf::from(std::env::var("HOME").unwrap())
            .join(".local/share/aria/models/en_GB-alan-medium.onnx");
        let mut tts = PiperTts::new(&voice, 1.0).unwrap();
        let pcm = tts.synth("Hello, I am Aria.").unwrap();
        // ~1 s of speech at 22 kHz — sanity band, not exact.
        assert!(pcm.len() > 8_000, "too short: {}", pcm.len());
        let peak = pcm.iter().map(|&s| (s as i32).abs()).max().unwrap();
        assert!(peak > 1_000, "silent output, peak {peak}");
        assert!(tts.synth("").unwrap().is_empty());
    }
}
