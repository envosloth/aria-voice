//! Golden pipeline test (spec §11.3): fixture WAV → real wake → real STT →
//! recorded LLM → real TTS → PCM, asserted against tolerances. No mic, no
//! speaker, no network — the v2 `smoke:all` equivalent.

use aria_core::{ChatMsg, Llm, StageError, Stt, Tts, WakeWord};
use aria_stt::WhisperStt;
use aria_tts::PiperTts;
use aria_wake::{OnnxWake, CHUNK};
use std::path::PathBuf;

fn models() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap()).join(".local/share/aria/models")
}

/// "Recorded" LLM: canned sentences, streamed like the gateway would.
struct RecordedLlm;
impl Llm for RecordedLlm {
    fn complete(
        &mut self,
        history: &[ChatMsg],
        on_sentence: &mut dyn FnMut(&str) -> bool,
    ) -> Result<(), StageError> {
        let prompt = &history.last().unwrap().content;
        assert!(prompt.to_lowercase().contains("jarvis"), "prompt was: {prompt}");
        on_sentence("Yes, I heard you.");
        on_sentence("How can I help?");
        Ok(())
    }
}

#[test]
fn golden_wav_to_speech() {
    let wav = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/hey_jarvis_16k.wav");
    let mut reader = hound::WavReader::open(wav).unwrap();
    let pcm: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();

    // Wake fires on the fixture.
    let mut wake = OnnxWake::new(&models(), "hey_jarvis_v0.1.onnx", 0.4, 1500).unwrap();
    let mut fired = false;
    for chunk in pcm.chunks(CHUNK) {
        fired |= wake.process(chunk);
    }
    assert!(fired, "wake did not fire (peak {})", wake.last_score);

    // STT hears the phrase.
    let mut stt = WhisperStt::new(&models().join("ggml-tiny.en.bin"), 0).unwrap();
    let text = stt.transcribe(&pcm).unwrap();
    assert!(text.to_lowercase().contains("jarvis"), "stt: {text}");

    // Recorded LLM streams sentences into real TTS.
    let mut tts = PiperTts::new(&models().join("en_GB-alan-medium.onnx"), 1.0).unwrap();
    let mut out_pcm: Vec<i16> = Vec::new();
    let history = [ChatMsg::now("user", &text)];
    RecordedLlm
        .complete(&history, &mut |s| {
            out_pcm.extend(tts.synth(s).unwrap());
            true
        })
        .unwrap();

    // Tolerance band: two short sentences ≈ 1–6 s of 22.05 kHz audio.
    let secs = out_pcm.len() as f32 / 22_050.0;
    assert!((0.8..8.0).contains(&secs), "reply audio {secs:.2}s");
    let peak = out_pcm.iter().map(|&s| (s as i32).abs()).max().unwrap();
    assert!(peak > 1_000, "reply audio silent");
}
