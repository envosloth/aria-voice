//! Kokoro TTS via ort: espeak IPA phonemes → vocab tokens → StyleTTS2 ONNX.
//! Ported from kokoro-onnx (v2's engine): style row = voice[token_count],
//! tokens padded with 0 at both ends, max 510 phonemes, 24 kHz output.

use std::collections::HashMap;
use std::path::Path;

use aria_core::StageError;
use ort::session::Session;
use ort::value::Tensor;

pub const SAMPLE_RATE: u32 = 24_000;
const MAX_PHONEMES: usize = 510;
const STYLE_DIM: usize = 256;

/// The four bundled voices + which espeak language each speaks.
/// bm_george is the British "Jarvis" default.
pub const VOICES: &[(&str, &str)] = &[
    ("bm_george", "en-gb-x-rp"),
    ("af_heart", "en-us"),
    ("af_bella", "en-us"),
    ("am_michael", "en-us"),
];

pub struct KokoroTts {
    session: Session,
    vocab: HashMap<char, i64>,
    /// Flattened (510, 256) style table for the active voice.
    style: Vec<f32>,
    lang: &'static str,
    speed: f32,
    /// Newer ONNX exports name the token input `input_ids` and take int speed.
    new_style_inputs: bool,
}

impl KokoroTts {
    pub fn new(model_dir: &Path, voice: &str, speed: f32) -> Result<Self, StageError> {
        let err = |m: String| StageError::Engine(m);
        let session = Session::builder()
            .and_then(|mut b| b.commit_from_file(model_dir.join("kokoro-v1.0.onnx")))
            .map_err(|e| err(format!("kokoro load: {e}")))?;
        let new_style_inputs = session.inputs().iter().any(|i| i.name() == "input_ids");
        let vocab = load_vocab()?;
        let style = load_voice_style(&model_dir.join("voices-v1.0.bin"), voice)?;
        let lang = VOICES
            .iter()
            .find(|(v, _)| *v == voice)
            .map(|(_, l)| *l)
            .unwrap_or(if voice.starts_with('b') { "en-gb-x-rp" } else { "en-us" });
        Ok(Self { session, vocab, style, lang, speed, new_style_inputs })
    }

    pub fn set_speed(&mut self, speed: f32) {
        self.speed = speed.clamp(0.5, 2.0);
    }

    /// Synthesize one sentence; returns 24 kHz mono i16.
    pub fn synth_raw(&mut self, text: &str) -> Result<Vec<i16>, StageError> {
        let phonemes = espeak_rs::text_to_phonemes(text, self.lang, None)
            .map_err(|e| StageError::Engine(format!("phonemize: {e:?}")))?
            .join(" ");
        let mut tokens: Vec<i64> = phonemes
            .chars()
            .filter_map(|c| self.vocab.get(&c).copied())
            .collect();
        // Style table has rows 0..=509; index = token count, so cap at 509
        // (a full 510-token sentence would read past the table and panic).
        tokens.truncate(MAX_PHONEMES - 1);
        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        // Style row indexed by token count (the kokoro-onnx contract).
        let row = &self.style[tokens.len() * STYLE_DIM..(tokens.len() + 1) * STYLE_DIM];
        let mut padded = Vec::with_capacity(tokens.len() + 2);
        padded.push(0i64);
        padded.extend(&tokens);
        padded.push(0);

        let n = padded.len();
        let tok = Tensor::from_array(([1usize, n], padded))
            .map_err(|e| StageError::Engine(format!("kokoro tokens: {e}")))?;
        let style = Tensor::from_array(([1usize, STYLE_DIM], row.to_vec()))
            .map_err(|e| StageError::Engine(format!("kokoro style: {e}")))?;
        let outputs = if self.new_style_inputs {
            let speed = Tensor::from_array(([1usize], vec![self.speed as i32]))
                .map_err(|e| StageError::Engine(format!("kokoro speed: {e}")))?;
            self.session
                .run(ort::inputs!["input_ids" => tok, "style" => style, "speed" => speed])
        } else {
            let speed = Tensor::from_array(([1usize], vec![self.speed]))
                .map_err(|e| StageError::Engine(format!("kokoro speed: {e}")))?;
            self.session
                .run(ort::inputs!["tokens" => tok, "style" => style, "speed" => speed])
        }
        .map_err(|e| StageError::Engine(format!("kokoro run: {e}")))?;
        let (_, audio) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| StageError::Engine(format!("kokoro out: {e}")))?;
        Ok(audio
            .iter()
            .map(|&f| (f.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect())
    }
}

fn load_vocab() -> Result<HashMap<char, i64>, StageError> {
    // Vocab ships with the binary — 114 IPA symbols, stable per model version.
    let json: serde_json::Value =
        serde_json::from_str(include_str!("../assets/kokoro-vocab.json"))
            .map_err(|e| StageError::Engine(format!("kokoro vocab: {e}")))?;
    let map = json["vocab"]
        .as_object()
        .ok_or_else(|| StageError::Engine("kokoro vocab shape".into()))?;
    Ok(map
        .iter()
        .filter_map(|(k, v)| Some((k.chars().next()?, v.as_i64()?)))
        .collect())
}

/// voices-v1.0.bin is an uncompressed npz (zip of .npy). Minimal stored-entry
/// reader: find the voice's local file header, parse the npy header, return
/// the f32 data. ponytail: full zip/npy crates not needed for one stored file.
fn load_voice_style(path: &Path, voice: &str) -> Result<Vec<f32>, StageError> {
    let bytes = std::fs::read(path)
        .map_err(|e| StageError::Engine(format!("voices file {}: {e}", path.display())))?;
    let name = format!("{voice}.npy");
    // Walk the central directory (local headers may defer sizes to data
    // descriptors, so they can't be trusted for skipping).
    let eocd = bytes
        .windows(4)
        .rposition(|w| w == b"PK\x05\x06")
        .ok_or_else(|| StageError::Engine("voices file: no zip EOCD".into()))?;
    let cd_start = u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
    let mut pos = cd_start;
    while pos + 46 <= bytes.len() && &bytes[pos..pos + 4] == b"PK\x01\x02" {
        let u16le = |o: usize| u16::from_le_bytes(bytes[o..o + 2].try_into().unwrap()) as usize;
        let u32le = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()) as usize;
        let compressed = u32le(pos + 20);
        let name_len = u16le(pos + 28);
        let extra_len = u16le(pos + 30);
        let comment_len = u16le(pos + 32);
        let local_off = u32le(pos + 42);
        let entry_name =
            std::str::from_utf8(&bytes[pos + 46..pos + 46 + name_len]).unwrap_or_default();
        if entry_name == name {
            // Data begins after the entry's LOCAL header (its own name/extra).
            let lname = u16le(local_off + 26);
            let lextra = u16le(local_off + 28);
            let data_start = local_off + 30 + lname + lextra;
            return parse_npy_f32(&bytes[data_start..data_start + compressed]);
        }
        pos += 46 + name_len + extra_len + comment_len;
    }
    Err(StageError::Engine(format!("voice '{voice}' not found in {}", path.display())))
}

fn parse_npy_f32(npy: &[u8]) -> Result<Vec<f32>, StageError> {
    if npy.len() < 10 || &npy[..6] != b"\x93NUMPY" {
        return Err(StageError::Engine("bad npy header".into()));
    }
    let header_len = u16::from_le_bytes([npy[8], npy[9]]) as usize;
    let data = &npy[10 + header_len..];
    Ok(data
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn models() -> PathBuf {
        PathBuf::from(std::env::var("HOME").unwrap()).join(".local/share/aria/models")
    }

    #[test]
    fn kokoro_synthesizes_jarvis_voice() {
        let mut k = KokoroTts::new(&models(), "bm_george", 1.0).unwrap();
        let pcm = k.synth_raw("Good evening. All systems are online.").unwrap();
        let secs = pcm.len() as f32 / SAMPLE_RATE as f32;
        assert!((0.8..8.0).contains(&secs), "duration {secs}s");
        let peak = pcm.iter().map(|&s| (s as i32).abs()).max().unwrap();
        assert!(peak > 2_000, "silent, peak {peak}");
    }

    #[test]
    fn very_long_text_does_not_panic() {
        let mut k = KokoroTts::new(&models(), "bm_george", 1.0).unwrap();
        // ~600+ phonemes once espeak expands it — must clamp, not crash (A-6 spirit)
        let long = "the quick brown fox jumps over the lazy dog and keeps running ".repeat(20);
        let pcm = k.synth_raw(&long).unwrap();
        assert!(!pcm.is_empty());
    }

    #[test]
    fn all_bundled_voices_load() {
        for (v, _) in VOICES {
            load_voice_style(&models().join("voices-v1.0.bin"), v).unwrap();
        }
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use std::path::PathBuf;

    #[test]
    #[ignore] // cargo test -p aria-tts --release -- --ignored --nocapture
    fn synth_latency() {
        let models = PathBuf::from(std::env::var("HOME").unwrap()).join(".local/share/aria/models");
        let mut k = KokoroTts::new(&models, "bm_george", 1.0).unwrap();
        let _ = k.synth_raw("warm up"); // espeak + first inference
        let t0 = std::time::Instant::now();
        let pcm = k.synth_raw("Yes sir, right away.").unwrap();
        println!(
            "kokoro sentence: {} ms for {:.1} s of audio",
            t0.elapsed().as_millis(),
            pcm.len() as f32 / SAMPLE_RATE as f32
        );
    }
}
