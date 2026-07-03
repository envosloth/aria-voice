//! Trait fakes (spec §11.1): the whole loop runs with no models/GPU/network.

use crate::traits::*;

/// Fires after a set number of frames.
pub struct FakeWake {
    frames_until_fire: usize,
    seen: usize,
}

impl FakeWake {
    pub fn new(frames_until_fire: usize) -> Self {
        Self { frames_until_fire, seen: 0 }
    }
}

impl WakeWord for FakeWake {
    fn process(&mut self, _frame: &[i16]) -> bool {
        self.seen += 1;
        self.seen >= self.frames_until_fire
    }
}

/// Returns a canned transcript; records what it was fed.
pub struct FakeStt {
    pub transcript: String,
    pub last_input_len: usize,
}

impl FakeStt {
    pub fn new(transcript: &str) -> Self {
        Self { transcript: transcript.into(), last_input_len: 0 }
    }
}

impl Stt for FakeStt {
    fn transcribe(&mut self, pcm_16k: &[i16]) -> Result<String, StageError> {
        self.last_input_len = pcm_16k.len();
        Ok(self.transcript.clone())
    }
}

/// Streams canned sentences; records the prompt.
pub struct FakeLlm {
    pub sentences: Vec<String>,
    pub last_prompt: String,
}

impl FakeLlm {
    pub fn new(sentences: &[&str]) -> Self {
        Self {
            sentences: sentences.iter().map(|s| s.to_string()).collect(),
            last_prompt: String::new(),
        }
    }
}

impl Llm for FakeLlm {
    fn complete(
        &mut self,
        history: &[ChatMsg],
        on_sentence: &mut dyn FnMut(&str) -> bool,
    ) -> Result<(), StageError> {
        self.last_prompt = history.last().map(|m| m.content.clone()).unwrap_or_default();
        for s in &self.sentences {
            if !on_sentence(s) {
                break;
            }
        }
        Ok(())
    }
}

/// One sample per input char; counts stops.
#[derive(Default)]
pub struct FakeTts {
    pub synthesized: Vec<String>,
    pub stops: usize,
}

impl Tts for FakeTts {
    fn synth(&mut self, text: &str) -> Result<Vec<i16>, StageError> {
        self.synthesized.push(text.into());
        Ok(vec![0i16; text.len()])
    }

    fn stop(&mut self) {
        self.stops += 1;
    }
}

/// Serves a fixed PCM buffer, then reports end-of-utterance (read → 0).
pub struct FakeAudioSource {
    pcm: Vec<i16>,
    pos: usize,
}

impl FakeAudioSource {
    pub fn new(pcm: Vec<i16>) -> Self {
        Self { pcm, pos: 0 }
    }
}

impl AudioSource for FakeAudioSource {
    fn read(&mut self, buf: &mut [i16]) -> usize {
        let n = buf.len().min(self.pcm.len() - self.pos);
        buf[..n].copy_from_slice(&self.pcm[self.pos..self.pos + n]);
        self.pos += n;
        n
    }
}

/// Accumulates everything written.
#[derive(Default)]
pub struct FakeAudioSink {
    pub written: Vec<i16>,
}

impl AudioSink for FakeAudioSink {
    fn write(&mut self, pcm: &[i16]) {
        self.written.extend_from_slice(pcm);
    }
}
