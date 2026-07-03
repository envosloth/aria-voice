//! Session FSM (spec §4.1). Pure state machine: event in, actions out. No I/O.

use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Idle,
    Listening,
    Thinking,
    Speaking,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Stage {
    Wake,
    Stt,
    Llm,
    Tts,
    Audio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    WakeDetected,
    UtteranceEnded,
    SpeechStarted,
    SpeechFinished,
    /// Wake word or energy while speaking (A-7).
    BargeIn,
    StageFailed(Stage),
    StageRecovered(Stage),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    CaptureUtterance,
    /// Run STT on the captured utterance, then LLM.
    Think,
    /// Cancel in-flight + queued TTS atomically (A-7).
    StopSpeech,
    /// Surface degradation via orb + log (§2.7 fail loud/degrade gracefully).
    AnnounceDegraded(Stage),
}

#[derive(Debug, Default)]
pub struct Fsm {
    state: State,
    degraded: HashSet<Stage>,
}

impl Default for State {
    fn default() -> Self {
        State::Idle
    }
}

impl Fsm {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn is_degraded(&self, stage: Stage) -> bool {
        self.degraded.contains(&stage)
    }

    /// Apply an event; returns actions the runtime must perform.
    pub fn handle(&mut self, event: Event) -> Vec<Action> {
        use Event::*;
        use State::*;
        match (self.state, event) {
            (Idle, WakeDetected) => {
                // A wake with a dead pipeline stage can't complete a turn.
                if [Stage::Stt, Stage::Llm, Stage::Tts]
                    .iter()
                    .any(|s| self.degraded.contains(s))
                {
                    return vec![];
                }
                self.state = Listening;
                vec![Action::CaptureUtterance]
            }
            (Listening, UtteranceEnded) => {
                self.state = Thinking;
                vec![Action::Think]
            }
            (Thinking, SpeechStarted) => {
                self.state = Speaking;
                vec![]
            }
            (Speaking, SpeechFinished) => {
                self.state = Idle;
                vec![]
            }
            (Speaking, BargeIn) => {
                self.state = Listening;
                vec![Action::StopSpeech, Action::CaptureUtterance]
            }
            (_, StageFailed(stage)) => {
                self.degraded.insert(stage);
                let was_speaking = self.state == Speaking;
                self.state = Idle;
                let mut actions = vec![Action::AnnounceDegraded(stage)];
                if was_speaking {
                    actions.insert(0, Action::StopSpeech);
                }
                actions
            }
            (_, StageRecovered(stage)) => {
                self.degraded.remove(&stage);
                vec![]
            }
            // Invalid combination: ignore, stay put (fail loud is the caller's
            // job in dev via logs; the FSM never panics).
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_turn(fsm: &mut Fsm) {
        assert_eq!(fsm.handle(Event::WakeDetected), vec![Action::CaptureUtterance]);
        assert_eq!(fsm.state(), State::Listening);
        assert_eq!(fsm.handle(Event::UtteranceEnded), vec![Action::Think]);
        assert_eq!(fsm.state(), State::Thinking);
        assert!(fsm.handle(Event::SpeechStarted).is_empty());
        assert_eq!(fsm.state(), State::Speaking);
        assert!(fsm.handle(Event::SpeechFinished).is_empty());
        assert_eq!(fsm.state(), State::Idle);
    }

    #[test]
    fn idle_to_speaking_to_idle() {
        full_turn(&mut Fsm::new());
    }

    #[test]
    fn barge_in_stops_speech_and_listens() {
        let mut fsm = Fsm::new();
        fsm.handle(Event::WakeDetected);
        fsm.handle(Event::UtteranceEnded);
        fsm.handle(Event::SpeechStarted);
        assert_eq!(
            fsm.handle(Event::BargeIn),
            vec![Action::StopSpeech, Action::CaptureUtterance]
        );
        assert_eq!(fsm.state(), State::Listening);
    }

    #[test]
    fn stage_failure_degrades_and_blocks_wake() {
        let mut fsm = Fsm::new();
        let actions = fsm.handle(Event::StageFailed(Stage::Stt));
        assert_eq!(actions, vec![Action::AnnounceDegraded(Stage::Stt)]);
        assert!(fsm.is_degraded(Stage::Stt));
        // Wake while STT is down: stay idle, do nothing.
        assert!(fsm.handle(Event::WakeDetected).is_empty());
        assert_eq!(fsm.state(), State::Idle);
        // Recovery restores the loop.
        fsm.handle(Event::StageRecovered(Stage::Stt));
        full_turn(&mut fsm);
    }

    #[test]
    fn failure_while_speaking_stops_speech_first() {
        let mut fsm = Fsm::new();
        fsm.handle(Event::WakeDetected);
        fsm.handle(Event::UtteranceEnded);
        fsm.handle(Event::SpeechStarted);
        assert_eq!(
            fsm.handle(Event::StageFailed(Stage::Tts)),
            vec![Action::StopSpeech, Action::AnnounceDegraded(Stage::Tts)]
        );
        assert_eq!(fsm.state(), State::Idle);
    }

    #[test]
    fn invalid_events_are_ignored() {
        let mut fsm = Fsm::new();
        assert!(fsm.handle(Event::SpeechFinished).is_empty());
        assert!(fsm.handle(Event::BargeIn).is_empty());
        assert_eq!(fsm.state(), State::Idle);
    }
}
