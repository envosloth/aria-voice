//! whisper.cpp STT (spec §6.3): warm/persistent context (B-1), 16 kHz mono
//! int16 in. GPU backend via cargo features (vulkan/cuda/metal), CPU default.

use std::path::Path;

use aria_core::{StageError, Stt};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub struct WhisperStt {
    ctx: WhisperContext, // held warm for the process lifetime — never reload per utterance
    threads: i32,
}

impl WhisperStt {
    /// `threads` 0 = auto (physical cores, capped — A-12).
    pub fn new(model: &Path, threads: usize) -> Result<Self, StageError> {
        let ctx = WhisperContext::new_with_params(
            model.to_str().unwrap_or_default(),
            WhisperContextParameters::default(),
        )
        .map_err(|e| StageError::Engine(format!("whisper load: {e}")))?;
        let threads = if threads == 0 {
            (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 2).clamp(1, 8)
        } else {
            threads
        };
        Ok(Self { ctx, threads: threads as i32 })
    }
}

impl Stt for WhisperStt {
    fn transcribe(&mut self, pcm_16k: &[i16]) -> Result<String, StageError> {
        if pcm_16k.is_empty() {
            return Ok(String::new()); // A-6: empty input is a no-op, not a crash
        }
        let samples: Vec<f32> = pcm_16k.iter().map(|&s| s as f32 / 32768.0).collect();
        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| StageError::Engine(format!("whisper state: {e}")))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(self.threads);
        params.set_language(Some("en"));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        state
            .full(params, &samples)
            .map_err(|e| StageError::Engine(format!("whisper full: {e}")))?;
        let mut out = String::new();
        for i in 0..state.full_n_segments() {
            if let Some(seg) = state.get_segment(i) {
                if let Ok(text) = seg.to_str() {
                    out.push_str(text.trim());
                    out.push(' ');
                }
            }
        }
        Ok(out.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn models() -> PathBuf {
        PathBuf::from(std::env::var("HOME").unwrap()).join(".local/share/aria/models")
    }

    #[test]
    fn transcribes_fixture_and_survives_bad_input() {
        let mut stt = WhisperStt::new(&models().join("ggml-tiny.en.bin"), 0).unwrap();

        // A-6 shapes first: empty, odd, tiny buffers must not crash.
        assert_eq!(stt.transcribe(&[]).unwrap(), "");
        let _ = stt.transcribe(&[0i16; 3]);
        let _ = stt.transcribe(&vec![0i16; 1601]);

        let wav = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/hey_jarvis_16k.wav");
        let mut r = hound::WavReader::open(wav).unwrap();
        let pcm: Vec<i16> = r.samples::<i16>().map(|s| s.unwrap()).collect();
        let text = stt.transcribe(&pcm).unwrap().to_lowercase();
        assert!(text.contains("jarvis"), "got: {text}");
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    use std::path::PathBuf;

    #[test]
    #[ignore] // timing bench, run explicitly: cargo test -p aria-stt --release --features vulkan -- --ignored --nocapture
    fn warm_latency() {
        let models = PathBuf::from(std::env::var("HOME").unwrap()).join(".local/share/aria/models");
        let wav = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/hey_jarvis_16k.wav");
        let mut r = hound::WavReader::open(wav).unwrap();
        let pcm: Vec<i16> = r.samples::<i16>().map(|s| s.unwrap()).collect();
        for model in ["tiny.en", "base.en"] {
            let mut stt = WhisperStt::new(&models.join(format!("ggml-{model}.bin")), 0).unwrap();
            let _ = stt.transcribe(&pcm); // warm
            let t0 = std::time::Instant::now();
            let text = stt.transcribe(&pcm).unwrap();
            println!("{model}: {} ms warm ({} s audio) -> {text}", t0.elapsed().as_millis(), pcm.len() / 16000);
        }
    }
}
