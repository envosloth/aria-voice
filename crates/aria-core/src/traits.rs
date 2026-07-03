//! Component traits (spec §4.2, §6). All engines are sync — inference runs on
//! dedicated blocking threads per §5.1, never on an async pool.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StageError {
    #[error("engine failed: {0}")]
    Engine(String),
}

/// One conversation message; the whole session history (with timestamps) is
/// fed back each turn so context is never lost between turns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMsg {
    /// "user" | "assistant"
    pub role: String,
    pub content: String,
    /// Unix seconds when the message was created.
    pub at: u64,
}

impl ChatMsg {
    pub fn now(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
            at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        }
    }
}

/// Wake-word detector. Input contract: 16 kHz mono int16 frames (A-4).
pub trait WakeWord: Send {
    /// Returns true when the wake word is detected in this frame.
    fn process(&mut self, frame: &[i16]) -> bool;
    /// Live sensitivity control (raised while ARIA speaks so it doesn't
    /// wake itself); engines without one ignore it.
    fn set_threshold(&mut self, _threshold: f32) {}
}

/// Speech-to-text. Input contract: 16 kHz mono int16, endpointed utterance (§6.3).
pub trait Stt: Send {
    fn transcribe(&mut self, pcm_16k: &[i16]) -> Result<String, StageError>;
}

/// LLM completion, streamed. `history` is the full session so far — its last
/// entry is the current user message. `on_sentence` fires per sentence as
/// tokens arrive, so TTS can start eagerly (A-8); returning `false` aborts
/// the stream promptly (barge-in must not wait for the full reply).
pub trait Llm: Send {
    fn complete(
        &mut self,
        history: &[ChatMsg],
        on_sentence: &mut dyn FnMut(&str) -> bool,
    ) -> Result<(), StageError>;

    /// Attach an image (data URL) to the next request's user message —
    /// engines without vision ignore it.
    fn set_image(&mut self, _data_url: Option<String>) {}
}

/// Text-to-speech. `stop` must cancel in-flight and queued work atomically (A-7).
pub trait Tts: Send {
    fn synth(&mut self, text: &str) -> Result<Vec<i16>, StageError>;
    fn stop(&mut self);
    /// Live speech-rate control (§6.5); engines without one ignore it.
    fn set_speed(&mut self, _speed: f32) {}
}

/// Capture source, already resampled to 16 kHz mono int16 (§6.1).
pub trait AudioSource: Send {
    /// Fills `buf`, returns samples written; 0 = end of utterance/stream.
    fn read(&mut self, buf: &mut [i16]) -> usize;
}

/// Playback sink fed by a bounded queue upstream (§6.1).
pub trait AudioSink: Send {
    fn write(&mut self, pcm: &[i16]);
}
