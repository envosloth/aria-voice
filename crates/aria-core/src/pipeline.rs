//! Voice-loop runner (spec §4.3), drivable end-to-end with fakes (§11.1, M0).
//!
//! ponytail: synchronous single-turn driver. The threaded runtime (RT audio
//! thread + blocking inference workers, §5.1) replaces this in M1/M2; the
//! FSM/trait seams it exercises are the ones that carry forward.

use crate::fsm::{Action, Event, Fsm, State};
use crate::traits::*;

pub struct Engines<'a> {
    pub wake: &'a mut dyn WakeWord,
    pub stt: &'a mut dyn Stt,
    pub llm: &'a mut dyn Llm,
    pub tts: &'a mut dyn Tts,
    pub source: &'a mut dyn AudioSource,
    pub sink: &'a mut dyn AudioSink,
}

/// What happened during one turn — for tests and the demo binary.
#[derive(Debug, Default)]
pub struct TurnLog {
    pub states: Vec<State>,
    pub transcript: String,
    pub reply_sentences: Vec<String>,
}

const FRAME: usize = 1280; // 80 ms at 16 kHz, openWakeWord frame size

/// Drive one wake→listen→think→speak turn. Returns None if the stream ends
/// before the wake word fires.
pub fn run_turn(e: &mut Engines, fsm: &mut Fsm) -> Result<Option<TurnLog>, StageError> {
    let mut log = TurnLog::default();
    let mut buf = [0i16; FRAME];

    // Idle: scan frames for the wake word.
    loop {
        let n = e.source.read(&mut buf);
        if n == 0 {
            return Ok(None);
        }
        if e.wake.process(&buf[..n]) {
            apply(fsm, Event::WakeDetected, e, &mut log);
            break;
        }
    }
    if fsm.state() != State::Listening {
        return Ok(None); // degraded stage blocked the wake
    }

    // Listening: capture until end of utterance (source returns 0).
    let mut utterance = Vec::new();
    loop {
        let n = e.source.read(&mut buf);
        if n == 0 {
            break;
        }
        utterance.extend_from_slice(&buf[..n]);
    }
    apply(fsm, Event::UtteranceEnded, e, &mut log);

    // Thinking: STT → LLM, streaming sentences straight into TTS (A-8).
    log.transcript = e.stt.transcribe(&utterance)?;
    let history = [crate::traits::ChatMsg::now("user", &log.transcript)];
    let mut spoken: Vec<String> = Vec::new();
    e.llm.complete(&history, &mut |sentence| {
        spoken.push(sentence.to_string());
        true
    })?;
    for (i, sentence) in spoken.iter().enumerate() {
        let pcm = e.tts.synth(sentence)?;
        if i == 0 {
            apply(fsm, Event::SpeechStarted, e, &mut log);
        }
        e.sink.write(&pcm);
    }
    log.reply_sentences = spoken;
    apply(fsm, Event::SpeechFinished, e, &mut log);
    Ok(Some(log))
}

fn apply(fsm: &mut Fsm, event: Event, e: &mut Engines, log: &mut TurnLog) {
    for action in fsm.handle(event) {
        match action {
            Action::StopSpeech => e.tts.stop(),
            // CaptureUtterance/Think are the driver's own control flow above;
            // AnnounceDegraded becomes an orb/log event once those exist (M1+).
            _ => {}
        }
    }
    log.states.push(fsm.state());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fakes::*;
    use crate::fsm::Stage;

    #[test]
    fn full_loop_with_fakes() {
        let mut wake = FakeWake::new(3);
        let mut stt = FakeStt::new("what time is it");
        let mut llm = FakeLlm::new(&["It is noon.", "Anything else?"]);
        let mut tts = FakeTts::default();
        // 5 wake-scan frames + 1 utterance frame of audio.
        let mut source = FakeAudioSource::new(vec![100i16; FRAME * 4]);
        let mut sink = FakeAudioSink::default();
        let mut fsm = Fsm::new();

        let log = run_turn(
            &mut Engines {
                wake: &mut wake,
                stt: &mut stt,
                llm: &mut llm,
                tts: &mut tts,
                source: &mut source,
                sink: &mut sink,
            },
            &mut fsm,
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            log.states,
            vec![State::Listening, State::Thinking, State::Speaking, State::Idle]
        );
        assert_eq!(log.transcript, "what time is it");
        assert_eq!(llm.last_prompt, "what time is it");
        assert_eq!(tts.synthesized, vec!["It is noon.", "Anything else?"]);
        // Sink received one sample per reply char (FakeTts contract).
        assert_eq!(sink.written.len(), "It is noon.".len() + "Anything else?".len());
        // Utterance PCM (frame 4) reached STT.
        assert_eq!(stt.last_input_len, FRAME);
    }

    #[test]
    fn no_wake_no_turn() {
        let mut wake = FakeWake::new(100); // never fires in 2 frames
        let mut stt = FakeStt::new("x");
        let mut llm = FakeLlm::new(&["y"]);
        let mut tts = FakeTts::default();
        let mut source = FakeAudioSource::new(vec![0i16; FRAME * 2]);
        let mut sink = FakeAudioSink::default();
        let mut fsm = Fsm::new();

        let log = run_turn(
            &mut Engines {
                wake: &mut wake,
                stt: &mut stt,
                llm: &mut llm,
                tts: &mut tts,
                source: &mut source,
                sink: &mut sink,
            },
            &mut fsm,
        )
        .unwrap();
        assert!(log.is_none());
        assert!(tts.synthesized.is_empty());
    }

    #[test]
    fn degraded_stt_blocks_the_turn() {
        let mut wake = FakeWake::new(1);
        let mut stt = FakeStt::new("x");
        let mut llm = FakeLlm::new(&["y"]);
        let mut tts = FakeTts::default();
        let mut source = FakeAudioSource::new(vec![0i16; FRAME]);
        let mut sink = FakeAudioSink::default();
        let mut fsm = Fsm::new();
        fsm.handle(crate::fsm::Event::StageFailed(Stage::Stt));

        let log = run_turn(
            &mut Engines {
                wake: &mut wake,
                stt: &mut stt,
                llm: &mut llm,
                tts: &mut tts,
                source: &mut source,
                sink: &mut sink,
            },
            &mut fsm,
        )
        .unwrap();
        assert!(log.is_none());
        assert_eq!(fsm.state(), State::Idle);
    }
}
