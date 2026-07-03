//! aria-core — traits, session FSM, config. No I/O deps (spec §4.2).

pub mod config;
pub mod fakes;
pub mod fsm;
pub mod pipeline;
pub mod traits;

/// Live playback level, written by the audio output callback (RT-safe) and
/// read by the UI so the orb reacts to the agent's actual voice (spec §6.6).
pub mod meter {
    use std::sync::atomic::{AtomicU32, Ordering};
    static OUTPUT_RMS: AtomicU32 = AtomicU32::new(0);
    pub fn set(v: f32) {
        OUTPUT_RMS.store(v.to_bits(), Ordering::Relaxed);
    }
    pub fn get() -> f32 {
        f32::from_bits(OUTPUT_RMS.load(Ordering::Relaxed))
    }
}

pub use config::Config;
pub use fsm::{Action, Event, Fsm, Stage, State};
pub use traits::{AudioSink, AudioSource, ChatMsg, Llm, StageError, Stt, Tts, WakeWord};
