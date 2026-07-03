//! openWakeWord pipeline on ort (spec §6.2): melspectrogram → embedding →
//! wake model. Input contract: 16 kHz mono int16 (A-4). CPU only.

use std::collections::VecDeque;
use std::path::Path;

use aria_core::WakeWord;
use ort::session::Session;
use ort::value::Tensor;

/// 80 ms at 16 kHz — openWakeWord's native chunk.
pub const CHUNK: usize = 1280;
const MEL_CTX: usize = 480; // 3 frames of left context, as openWakeWord does
const MEL_PER_CHUNK: usize = 8; // 1280 / 160 hop
const EMB_WINDOW: usize = 76; // mel frames per embedding
const WAKE_WINDOW: usize = 16; // embeddings per wake-model run

#[derive(Debug, thiserror::Error)]
pub enum WakeError {
    #[error("onnx: {0}")]
    Ort(#[from] ort::Error),
}

pub struct OnnxWake {
    melspec: Session,
    embedding: Session,
    wake: Session,
    threshold: f32,
    cooldown_chunks: u32,
    // streaming state
    pending: Vec<i16>,
    raw: VecDeque<i16>,
    mel_buf: VecDeque<[f32; 32]>,
    emb_buf: VecDeque<[f32; 96]>,
    cooldown: u32,
    pub last_score: f32,
}

impl OnnxWake {
    /// `model_dir` must hold melspectrogram.onnx, embedding_model.onnx and the
    /// wake model file (e.g. hey_jarvis_v0.1.onnx). Custom wake word = a
    /// different `wake_model` file, no rebuild (§6.2).
    pub fn new(
        model_dir: &Path,
        wake_model: &str,
        threshold: f32,
        cooldown_ms: u64,
    ) -> Result<Self, WakeError> {
        let load = |file: &str| Session::builder()?.commit_from_file(model_dir.join(file));
        Ok(Self {
            melspec: load("melspectrogram.onnx")?,
            embedding: load("embedding_model.onnx")?,
            wake: load(wake_model)?,
            threshold,
            cooldown_chunks: (cooldown_ms / 80) as u32,
            pending: Vec::with_capacity(CHUNK),
            raw: VecDeque::with_capacity(CHUNK + MEL_CTX),
            // Pre-fill with 1.0 rows exactly like openWakeWord's
            // `np.ones((76,32))` init: detection windows must END at the wake
            // phrase from the very first chunk, or early wakes are missed.
            mel_buf: VecDeque::from(vec![[1.0f32; 32]; EMB_WINDOW]),
            emb_buf: VecDeque::with_capacity(WAKE_WINDOW),
            cooldown: 0,
            last_score: 0.0,
        })
    }

    fn run_chunk(&mut self, chunk: &[i16]) -> Result<bool, WakeError> {
        // 1. Melspectrogram over chunk + left context; keep the 8 new frames.
        //    openWakeWord feeds raw int16 magnitudes as f32, then x/10 + 2.
        self.raw.extend(chunk);
        while self.raw.len() > CHUNK + MEL_CTX {
            self.raw.pop_front();
        }
        let samples: Vec<f32> = self.raw.iter().map(|&s| s as f32).collect();
        let n = samples.len();
        let input = Tensor::from_array(([1usize, n], samples))?;
        let outputs = self.melspec.run(ort::inputs![input])?;
        let (_, mel) = outputs[0].try_extract_tensor::<f32>()?;
        let frames = mel.len() / 32;
        for f in frames.saturating_sub(MEL_PER_CHUNK)..frames {
            let mut row = [0f32; 32];
            for (i, v) in mel[f * 32..(f + 1) * 32].iter().enumerate() {
                row[i] = v / 10.0 + 2.0;
            }
            self.mel_buf.push_back(row);
        }
        while self.mel_buf.len() > EMB_WINDOW {
            self.mel_buf.pop_front();
        }

        // 2. Embedding over the last 76 mel frames → 96-dim feature.
        let flat: Vec<f32> = self.mel_buf.iter().flatten().copied().collect();
        let input = Tensor::from_array(([1usize, EMB_WINDOW, 32, 1], flat))?;
        let outputs = self.embedding.run(ort::inputs![input])?;
        let (_, emb) = outputs[0].try_extract_tensor::<f32>()?;
        let mut e = [0f32; 96];
        e.copy_from_slice(&emb[..96]);
        self.emb_buf.push_back(e);
        while self.emb_buf.len() > WAKE_WINDOW {
            self.emb_buf.pop_front();
        }
        if self.emb_buf.len() < WAKE_WINDOW {
            return Ok(false);
        }

        // 3. Wake model over the last 16 embeddings → score.
        let flat: Vec<f32> = self.emb_buf.iter().flatten().copied().collect();
        let input = Tensor::from_array(([1usize, WAKE_WINDOW, 96], flat))?;
        let outputs = self.wake.run(ort::inputs![input])?;
        let (_, score) = outputs[0].try_extract_tensor::<f32>()?;
        self.last_score = self.last_score.max(score[0]);

        if self.cooldown > 0 {
            self.cooldown -= 1;
            return Ok(false);
        }
        if score[0] >= self.threshold {
            self.cooldown = self.cooldown_chunks;
            return Ok(true);
        }
        Ok(false)
    }
}

impl WakeWord for OnnxWake {
    fn set_threshold(&mut self, threshold: f32) {
        self.threshold = threshold.clamp(0.05, 0.95);
    }

    fn process(&mut self, frame: &[i16]) -> bool {
        self.pending.extend_from_slice(frame);
        let mut detected = false;
        while self.pending.len() >= CHUNK {
            let chunk: Vec<i16> = self.pending.drain(..CHUNK).collect();
            // Engine errors mean "no detection", never a crash of the caller;
            // health/restart handling wraps this at the worker boundary (§5.2).
            detected |= self.run_chunk(&chunk).unwrap_or(false);
        }
        detected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn model_dir() -> PathBuf {
        dirs_model()
    }

    fn dirs_model() -> PathBuf {
        PathBuf::from(std::env::var("HOME").unwrap()).join(".local/share/aria/models")
    }

    fn engine() -> OnnxWake {
        OnnxWake::new(&model_dir(), "hey_jarvis_v0.1.onnx", 0.4, 1500).unwrap()
    }

    #[test]
    fn detects_hey_jarvis_fixture() {
        let wav = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/hey_jarvis_16k.wav");
        let mut reader = hound::WavReader::open(wav).unwrap();
        let pcm: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        let mut wake = engine();
        let mut detected = false;
        for chunk in pcm.chunks(CHUNK) {
            detected |= wake.process(chunk);
        }
        assert!(
            detected,
            "no detection; peak score {}",
            wake.last_score
        );
    }

    #[test]
    fn silence_does_not_fire() {
        let mut wake = engine();
        let silence = vec![0i16; CHUNK];
        for _ in 0..40 {
            // 3.2 s of silence
            assert!(!wake.process(&silence));
        }
    }

    #[test]
    fn odd_length_frames_are_buffered_not_crashed() {
        // A-6: odd/ragged buffer shapes crashed v2 native code.
        let mut wake = engine();
        for len in [1usize, 3, 7, 1279, 1281] {
            wake.process(&vec![0i16; len]);
        }
    }
}
