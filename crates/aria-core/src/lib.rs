//! aria-core — traits, session FSM, config. No I/O deps (spec §4.2).

pub mod config;
pub mod fakes;
pub mod fsm;
pub mod pipeline;
pub mod traits;

pub use config::Config;
pub use fsm::{Action, Event, Fsm, Stage, State};
pub use traits::{AudioSink, AudioSource, ChatMsg, Llm, StageError, Stt, Tts, WakeWord};
