//! The live voice loop (spec §4.3) on a dedicated pipeline thread, now also
//! serving the Glass Observatory UI: state/transcript/sentence events out,
//! typed asks + control commands in. Engine calls stay panic-isolated (§5.2).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use aria_audio::PlaybackSink;
use aria_core::{ChatMsg, Config, Event, Fsm, Llm, Stage, State, Stt, Tts, WakeWord};
use aria_orb::OrbState;
use aria_ui::{Settings, UiCommand, UiEvent};

use crate::router::{Route, Router};

pub struct Runtime {
    pub cfg: Config,
    pub wake: Box<dyn WakeWord>,
    pub stt: Box<dyn Stt>,
    /// Agent harness (tools + skills).
    pub llm: Box<dyn Llm>,
    /// Optional direct LLM (mixture mode) — shares `session` with the harness.
    pub llm_direct: Option<Box<dyn Llm>>,
    pub tts: Box<dyn Tts>,
    pub source: Box<dyn aria_core::AudioSource>,
    pub sink: PlaybackSink,
    pub tts_rate: u32,
    pub events: Sender<UiEvent>,
    /// Shared so the command stream survives a voice-pipeline restart (§5.3).
    pub cmds: Arc<Mutex<Receiver<UiCommand>>>,
    /// LLM circuit breaker (A-11): opens after N consecutive failures,
    /// auto-resets after the cooldown.
    pub llm_failures: u32,
    pub llm_breaker_until: Option<Instant>,
    /// Full session history, fed back each turn and persisted with timestamps.
    pub session: Vec<ChatMsg>,
    pub history_path: std::path::PathBuf,
    pub router: Router,
    /// Screen share: when on, each query carries a downscaled frame (A-19).
    pub screen_share: bool,
    /// Commands received mid-speech that must not be dropped (§A-7 fix:
    /// the old drain loop silently ate non-Stop commands).
    pub requeue: Vec<UiCommand>,
}

const FRAME: usize = 1280; // 80 ms @ 16 kHz
const FRAME_MS: u64 = 80;

/// Classic Whisper noise transcripts, only trusted when the audio was loud.
fn is_hallucination(text: &str, peak_rms: f32, energy_threshold: f32) -> bool {
    if peak_rms >= energy_threshold * 2.0 {
        return false; // clearly loud speech — believe it
    }
    let t = text.trim().to_lowercase();
    t.len() < 32
        && ["thank you", "thanks for watching", "you", "bye", "so", "okay", "silence", "..."]
            .iter()
            .any(|h| t.trim_end_matches(['.', '!', '?']) == *h || t.contains("watching"))
}

fn rms(frame: &[i16]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum: f64 = frame.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum / frame.len() as f64).sqrt() as f32
}

impl Runtime {
    fn emit(&self, ev: UiEvent) {
        let _ = self.events.send(ev); // headless mode: receiver dropped, fine
        aria_ui::ping_ui(); // drain promptly even if the compositor idled us
    }

    fn state(&self, orb: OrbState, label: &str) {
        self.emit(UiEvent::State(orb, label.to_string()));
    }

    fn activity(&self, line: impl Into<String>) {
        let line = line.into();
        println!("· {line}");
        self.emit(UiEvent::Activity(line));
    }

    fn try_cmd(&self) -> Result<UiCommand, TryRecvError> {
        self.cmds.lock().expect("cmds lock").try_recv()
    }

    /// Blocking loop; returns only on unrecoverable audio loss.
    pub fn run(&mut self) {
        let mut fsm = Fsm::new();
        println!("ARIA listening — say \"{}\"", self.cfg.wake.phrase);
        self.state(OrbState::Idle, "IDLE · STANDING BY");
        loop {
            let frame = self.read_frame();
            if fsm.state() != State::Idle {
                continue;
            }
            // UI commands are handled between frames while idle — including
            // any that arrived mid-speech and were requeued.
            let mut pending: Vec<UiCommand> = self.requeue.drain(..).collect();
            while let Ok(cmd) = self.try_cmd() {
                pending.push(cmd);
            }
            for cmd in pending {
                self.dispatch(cmd, &mut fsm);
            }
            if fsm.is_degraded(Stage::Wake) {
                continue;
            }
            match catch_unwind(AssertUnwindSafe(|| self.wake.process(&frame))) {
                Ok(true) => {
                    fsm.handle(Event::WakeDetected);
                    if fsm.state() == State::Listening {
                        self.activity("wake word detected");
                        self.emit(UiEvent::Show); // background mode: wake re-opens the window
                        self.turn(&mut fsm);
                    }
                }
                Ok(false) => {}
                Err(_) => {
                    self.activity("wake engine panicked — degraded");
                    fsm.handle(Event::StageFailed(Stage::Wake));
                }
            }
        }
    }

    fn dispatch(&mut self, cmd: UiCommand, fsm: &mut Fsm) {
        match cmd {
            UiCommand::Ask(text) => self.typed_turn(&text),
            UiCommand::Wake => {
                fsm.handle(Event::WakeDetected);
                if fsm.state() == State::Listening {
                    self.activity("wake (ui)");
                    self.turn(fsm);
                }
            }
            UiCommand::Stop => self.sink.stop_now(),
            UiCommand::SetVolume(v) => self.sink.set_volume(v),
            UiCommand::SetSpeed(v) => self.tts.set_speed(v),
            UiCommand::SetVoice(v) => self.set_voice(&v),
            UiCommand::ScreenShare(on) => self.set_screen_share(on),
            UiCommand::CheckUpdate => {
                let repo = self.cfg.update.repo.clone();
                let ev = self.events.clone();
                std::thread::spawn(move || crate::updater::check_and_update(&repo, ev));
            }
            UiCommand::SaveSettings(s) => self.save_settings(&s),
        }
    }

    /// One conversation: listen→think→speak, then keep listening for
    /// follow-ups (no wake word needed) until the user goes quiet.
    fn turn(&mut self, fsm: &mut Fsm) {
        self.chime(); // audible "I heard you"
        let mut first = true;
        loop {
            if !first {
                fsm.handle(Event::WakeDetected); // logical wake for the follow-up
            }
            self.wake.set_threshold(self.cfg.wake.threshold); // restore base
            self.state(
                OrbState::Speaking,
                if first { "LISTENING · CAPTURING" } else { "LISTENING · FOLLOW-UP" },
            );
            let start_timeout = if first {
                self.cfg.endpoint.speech_start_timeout_ms
            } else {
                self.cfg.endpoint.followup_window_ms
            };
            let (utterance, seen_speech, peak) = self.capture_utterance(start_timeout);
            if !seen_speech {
                if first {
                    self.activity("heard nothing");
                }
                self.reset(fsm);
                return;
            }
            fsm.handle(Event::UtteranceEnded);
            let audio_end = Instant::now(); // A-16
            self.state(OrbState::Thinking, "THINKING · TRANSCRIBING");

            let text = match catch_unwind(AssertUnwindSafe(|| self.stt.transcribe(&utterance))) {
                Ok(Ok(t)) if !t.is_empty() => t,
                Ok(Ok(_)) => {
                    self.activity("heard nothing");
                    self.reset(fsm);
                    return;
                }
                Ok(Err(e)) => {
                    self.activity(format!("stt error: {e}"));
                    self.reset(fsm);
                    return;
                }
                Err(_) => {
                    self.activity("stt panicked — degraded");
                    fsm.handle(Event::StageFailed(Stage::Stt));
                    self.state(OrbState::Idle, "IDLE · STT DEGRADED");
                    return;
                }
            };
            // Whisper hallucination guard: quiet audio + a classic filler
            // transcript = noise, not the user.
            if is_hallucination(&text, peak, self.cfg.endpoint.energy_threshold) {
                self.activity(format!("dropped low-energy transcript: {text}"));
                self.reset(fsm);
                return;
            }
            self.activity(format!("stt {} ms", audio_end.elapsed().as_millis()));
            self.emit(UiEvent::Perf("stt".into(), audio_end.elapsed().as_millis()));
            self.emit(UiEvent::Heard(text.clone()));
            println!("· heard: {text}");

            // Self-barge-in guard: while ARIA speaks, the wake word must be
            // *much* clearer than usual (its own voice bleeds into the mic).
            self.wake.set_threshold((self.cfg.wake.threshold + 0.25).min(0.9));
            let (spoke, interrupt) = self.respond(&text, Some(audio_end));
            fsm.handle(Event::SpeechStarted);
            if let Some(cmd) = interrupt {
                self.emit(UiEvent::TurnDone);
                fsm.handle(Event::BargeIn);
                fsm.handle(Event::UtteranceEnded); // resolve FSM back through Thinking
                fsm.handle(Event::SpeechStarted);
                fsm.handle(Event::SpeechFinished);
                self.wake.set_threshold(self.cfg.wake.threshold);
                self.dispatch(cmd, fsm);
                return;
            }
            if spoke {
                // SPEAKING: watch for barge-in while the ring drains (A-7).
                while self.sink.queued() > 0 {
                    let frame = self.read_frame();
                    let wake_barge = matches!(
                        catch_unwind(AssertUnwindSafe(|| self.wake.process(&frame))),
                        Ok(true)
                    );
                    let cmd_barge = match self.try_cmd() {
                        Ok(UiCommand::Stop) => true,
                        Ok(UiCommand::Wake) => true,
                        Ok(UiCommand::Ask(t)) => {
                            self.sink.stop_now();
                            self.tts.stop();
                            self.activity("interrupted by new message");
                            fsm.handle(Event::SpeechFinished);
                            self.emit(UiEvent::TurnDone);
                            self.wake.set_threshold(self.cfg.wake.threshold);
                            self.typed_turn(&t);
                            return;
                        }
                        Ok(UiCommand::SetVolume(v)) => {
                            self.sink.set_volume(v);
                            false
                        }
                        Ok(other) => {
                            self.requeue.push(other); // never drop commands
                            false
                        }
                        Err(_) => false,
                    };
                    if wake_barge || cmd_barge {
                        self.activity("barge-in");
                        self.sink.stop_now();
                        self.tts.stop();
                        fsm.handle(Event::BargeIn);
                        // interrupted → stop speaking and LISTEN, right now
                        self.wake.set_threshold(self.cfg.wake.threshold);
                        fsm.handle(Event::UtteranceEnded);
                        fsm.handle(Event::SpeechStarted);
                        fsm.handle(Event::SpeechFinished);
                        self.turn(fsm);
                        return;
                    }
                }
            }
            fsm.handle(Event::SpeechFinished);
            self.emit(UiEvent::TurnDone);
            first = false;
            if self.cfg.endpoint.followup_window_ms == 0 {
                break;
            }
        }
        self.wake.set_threshold(self.cfg.wake.threshold);
        self.state(OrbState::Idle, "IDLE · STANDING BY");
    }

    /// Typed ask from the UI — same LLM+TTS path, no FSM (it guards the mic).
    fn typed_turn(&mut self, text: &str) {
        let t0 = Instant::now();
        let (_, interrupt) = self.respond(text, Some(t0));
        if let Some(cmd) = interrupt {
            self.emit(UiEvent::TurnDone);
            let mut fsm = Fsm::new();
            self.dispatch(cmd, &mut fsm);
            return;
        }
        // Let the reply play out; interruptions cut it.
        while self.sink.queued() > 0 {
            match self.try_cmd() {
                Ok(UiCommand::Stop) | Ok(UiCommand::Wake) => {
                    self.sink.stop_now();
                    self.tts.stop();
                    self.activity("interrupted");
                    break;
                }
                Ok(UiCommand::Ask(t)) => {
                    self.sink.stop_now();
                    self.tts.stop();
                    self.activity("interrupted by new message");
                    self.emit(UiEvent::TurnDone);
                    self.typed_turn(&t);
                    return;
                }
                Ok(UiCommand::SetVolume(v)) => self.sink.set_volume(v),
                Ok(other) => self.requeue.push(other),
                Err(_) => {}
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        self.emit(UiEvent::TurnDone);
        self.state(OrbState::Idle, "IDLE · STANDING BY");
    }

    fn push_history(&mut self, msg: ChatMsg) {
        if let Ok(line) = serde_json::to_string(&msg) {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.history_path)
            {
                let _ = writeln!(f, "{line}");
            }
        }
        self.session.push(msg);
    }

    /// Stream LLM reply into TTS + sink. The LLM runs on a worker thread so
    /// the runtime can inject a "still working" filler after a quiet 4 s —
    /// filler and reply share one bounded playback queue, so the filler can
    /// never cut off or be cut off by the reply (A-15). Returns whether audio
    /// was queued plus any command that interrupted the reply (Stop/Wake/Ask).
    fn respond(&mut self, prompt: &str, audio_end: Option<Instant>) -> (bool, Option<UiCommand>) {
        // Breaker open: fail fast instead of hammering a dead gateway (A-11).
        if let Some(until) = self.llm_breaker_until {
            if Instant::now() < until {
                let left = (until - Instant::now()).as_secs();
                self.activity(format!("gateway breaker open · retry in {left}s"));
                let note = "The gateway is unreachable, I will retry shortly.";
                self.emit(UiEvent::Sentence(note.into()));
                if let Ok(Ok(pcm)) = catch_unwind(AssertUnwindSafe(|| self.tts.synth(note))) {
                    self.sink.play(&pcm, self.tts_rate);
                    return (true, None);
                }
                return (false, None);
            }
            self.llm_breaker_until = None; // cooldown elapsed — auto-reset
            self.activity("gateway breaker reset");
        }

        // Voice-triggered screen share ("activate screen share" …).
        let lower = prompt.to_lowercase();
        if lower.contains("screen shar") || lower.contains("share my screen") {
            let on = ["activate", "start", "turn on", "enable", "share my"]
                .iter()
                .any(|k| lower.contains(k));
            let off = ["stop", "deactivate", "turn off", "disable", "end "]
                .iter()
                .any(|k| lower.contains(k));
            if on != off {
                self.set_screen_share(on);
                return (true, None);
            }
        }

        // Screen share: capture a glance-sized frame for this query (A-19).
        if self.screen_share {
            let t0 = Instant::now();
            match crate::screen::capture_data_url() {
                Ok(url) => {
                    self.activity(format!(
                        "frame captured · {} KB · {} ms",
                        url.len() * 3 / 4 / 1024,
                        t0.elapsed().as_millis()
                    ));
                    self.llm.set_image(Some(url));
                }
                Err(e) => self.activity(format!("screen capture failed: {e}")),
            }
        }

        // Mixture mode: pick the path, but share one session history (the
        // handoff requirement — a harness follow-up answer routes back).
        // Vision frames always need the harness.
        let route = if self.screen_share { Route::Harness } else { self.router.route(prompt) };
        if self.llm_direct.is_some() {
            self.activity(match route {
                Route::Harness => "routing → agent harness",
                Route::Direct => "routing → direct llm",
            });
        }
        self.push_history(ChatMsg::now("user", prompt));
        self.state(OrbState::Tools, "QUERYING GATEWAY");

        let session = self.session.clone();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let mut first_audio: Option<Duration> = None;
        let mut spoke = false;
        let mut first_sentence = true;
        let mut reply = String::new();

        let llm = match route {
            Route::Direct => self.llm_direct.as_mut().unwrap(),
            Route::Harness => &mut self.llm,
        };
        let tts = &mut self.tts;
        let sink = &mut self.sink;
        let wake = &mut self.wake;
        let source = &mut self.source;
        let tts_rate = self.tts_rate;
        let events = self.events.clone();
        let cmds = self.cmds.clone();
        let mut interrupt: Option<UiCommand> = None;
        let mut deferred: Vec<UiCommand> = Vec::new();
        // Shared with the LLM worker: setting this aborts the SSE stream
        // within one token, so a barge-in never waits for the full reply.
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut cancelled = false;

        let result: Result<(), aria_core::StageError> = std::thread::scope(|scope| {
            let cancel_w = cancel.clone();
            let worker = scope.spawn(move || {
                catch_unwind(AssertUnwindSafe(|| {
                    llm.complete(&session, &mut |sent| {
                        let _ = tx.send(sent.to_string());
                        !cancel_w.load(std::sync::atomic::Ordering::Relaxed)
                    })
                }))
                .unwrap_or_else(|_| Err(aria_core::StageError::Engine("llm panicked".into())))
            });
            let mut filler_played = false;
            let mut quiet_ticks = 0u32;
            loop {
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(sentence) => {
                        quiet_ticks = 0;
                        let _ = events.send(UiEvent::Sentence(sentence.clone()));
                        if first_sentence {
                            first_sentence = false;
                            let _ = events.send(UiEvent::State(
                                OrbState::Speaking,
                                "SPEAKING · STREAMING".into(),
                            ));
                        }
                        if !reply.is_empty() {
                            reply.push(' ');
                        }
                        reply.push_str(&sentence);
                        if !cancelled {
                            match catch_unwind(AssertUnwindSafe(|| tts.synth(&sentence))) {
                                Ok(Ok(pcm)) if !pcm.is_empty() => {
                                    if let Some(t0) = audio_end {
                                        first_audio.get_or_insert_with(|| t0.elapsed());
                                    }
                                    spoke = true;
                                    sink.play(&pcm, tts_rate);
                                }
                                Ok(Ok(_)) => {}
                                Ok(Err(e)) => eprintln!("tts error: {e}"),
                                Err(_) => eprintln!("tts panicked on: {sentence}"),
                            }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        quiet_ticks += 1;
                        // Long task (4 s quiet): acknowledge once; the reply
                        // queues behind this in the playback ring (A-15).
                        if quiet_ticks >= 20 && !filler_played && !spoke && !cancelled {
                            filler_played = true;
                            let _ = events
                                .send(UiEvent::Activity("long task — acknowledging".into()));
                            if let Ok(Ok(pcm)) = catch_unwind(AssertUnwindSafe(|| {
                                tts.synth("Still working on it.")
                            })) {
                                spoke = true;
                                sink.play(&pcm, tts_rate);
                            }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
                // Wake word during speech = barge-in (A-7): stop speaking,
                // go straight back to listening. The ring is drained every
                // tick so detection stays real-time.
                let mut wbuf = [0i16; 1280];
                loop {
                    let n = source.read(&mut wbuf);
                    if n == 0 {
                        break;
                    }
                    let hit = matches!(
                        catch_unwind(AssertUnwindSafe(|| wake.process(&wbuf[..n]))),
                        Ok(true)
                    );
                    if hit && !cancelled {
                        cancelled = true;
                        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                        sink.stop_now();
                        let _ = events.send(UiEvent::Activity("barge-in (wake word)".into()));
                        interrupt = Some(UiCommand::Wake);
                    }
                }
                // Interruption while streaming/speaking (A-7): the user can
                // always cut the agent off.
                if !cancelled {
                    if let Ok(cmd) = cmds.lock().expect("cmds lock").try_recv() {
                        match cmd {
                            UiCommand::Stop => {
                                cancelled = true;
                                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                                sink.stop_now();
                                let _ = events.send(UiEvent::Activity("interrupted".into()));
                            }
                            UiCommand::Wake | UiCommand::Ask(_) => {
                                cancelled = true;
                                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                                sink.stop_now();
                                let _ = events.send(UiEvent::Activity("interrupted".into()));
                                interrupt = Some(cmd);
                            }
                            UiCommand::SetVolume(v) => sink.set_volume(v),
                            UiCommand::SetSpeed(v) => tts.set_speed(v),
                            other => deferred.push(other), // handled after the turn
                        }
                    }
                }
            }
            worker
                .join()
                .unwrap_or_else(|_| Err(aria_core::StageError::Engine("llm worker died".into())))
        });

        match result {
            Ok(()) => {
                let _ = events.send(UiEvent::Gateway(true));
                self.llm_failures = 0;
            }
            Err(e) => {
                let _ = events.send(UiEvent::Gateway(false));
                println!("· llm error: {e}");
                let _ = events.send(UiEvent::Activity(format!("llm error: {e}")));
                self.llm_failures += 1;
                if self.llm_failures >= self.cfg.health.breaker_failure_threshold {
                    self.llm_breaker_until = Some(
                        Instant::now() + Duration::from_secs(self.cfg.health.breaker_cooldown_s),
                    );
                    let _ = events.send(UiEvent::Activity(format!(
                        "gateway breaker opened for {}s",
                        self.cfg.health.breaker_cooldown_s
                    )));
                }
                let apology = "Sorry, I can't reach my language model right now.";
                let _ = events.send(UiEvent::Sentence(apology.into()));
                if let Ok(Ok(pcm)) = catch_unwind(AssertUnwindSafe(|| tts.synth(apology))) {
                    sink.play(&pcm, tts_rate);
                    spoke = true;
                }
            }
        }
        self.requeue.extend(deferred); // never drop commands (fix: was lost)
        if !reply.is_empty() {
            self.push_history(ChatMsg::now("assistant", &reply));
            self.router.observe_reply(route, &reply);
        }
        if let Some(d) = first_audio {
            self.activity(format!("first audio {} ms", d.as_millis()));
            self.emit(UiEvent::Perf("first-audio".into(), d.as_millis()));
        }
        if let Some(t0) = audio_end {
            self.emit(UiEvent::Perf("full-reply".into(), t0.elapsed().as_millis()));
        }
        if cancelled {
            (false, interrupt)
        } else {
            (spoke, None)
        }
    }

    fn reset(&self, fsm: &mut Fsm) {
        // Transient failure: bounce the FSM back to Idle without degradation.
        fsm.handle(Event::StageFailed(Stage::Stt));
        fsm.handle(Event::StageRecovered(Stage::Stt));
        self.state(OrbState::Idle, "IDLE · STANDING BY");
    }

    /// Live voice switch with a spoken preview.
    fn set_voice(&mut self, voice: &str) {
        let models = self.cfg.models.expanded_dir();
        match aria_tts::AnyTts::load(&models, voice, self.cfg.tts.speed) {
            Ok(t) => {
                self.tts_rate = t.sample_rate();
                self.tts = Box::new(t);
                self.cfg.tts.voice = voice.to_string();
                self.activity(format!("voice → {voice}"));
                if let Ok(Ok(pcm)) = catch_unwind(AssertUnwindSafe(|| {
                    self.tts.synth("Hello. This is how I sound now.")
                })) {
                    self.sink.play(&pcm, self.tts_rate);
                }
            }
            Err(e) => self.activity(format!("voice switch failed: {e}")),
        }
    }

    fn set_screen_share(&mut self, on: bool) {
        self.screen_share = on;
        self.emit(UiEvent::ScreenShare(on));
        self.activity(if on { "screen share ON" } else { "screen share OFF" });
        let line = if on {
            "Screen share is on. I can see your screen now."
        } else {
            "Screen share is off."
        };
        self.emit(UiEvent::Sentence(line.into()));
        if let Ok(Ok(pcm)) = catch_unwind(AssertUnwindSafe(|| self.tts.synth(line))) {
            self.sink.play(&pcm, self.tts_rate);
        }
        self.emit(UiEvent::TurnDone);
    }

    fn save_settings(&mut self, s: &Settings) {
        self.tts.set_speed(s.tts_speed);
        self.sink.set_volume(s.volume);
        self.wake.set_threshold(s.wake_threshold); // live, no restart
        let mut cfg = self.cfg.clone();
        cfg.llm.endpoint = s.endpoint.clone();
        cfg.llm.model = s.model.clone();
        cfg.llm.api_key = s.api_key.clone();
        cfg.llm.routing = s.routing.clone();
        cfg.llm.direct_endpoint = s.direct_endpoint.clone();
        cfg.llm.direct_model = s.direct_model.clone();
        cfg.llm.direct_api_key = s.direct_api_key.clone();
        cfg.tts.voice = s.voice.clone();
        cfg.tts.speed = s.tts_speed;
        cfg.tts.volume = s.volume;
        cfg.wake.phrase = s.wake_phrase.clone();
        cfg.wake.threshold = s.wake_threshold;
        cfg.endpoint.energy_threshold = s.energy_threshold;
        cfg.endpoint.silence_ms = s.silence_ms;
        cfg.endpoint.followup_window_ms = s.followup_ms;
        cfg.perf.preset = s.preset.clone();
        cfg.stt.model = s.stt_model.clone();
        cfg.update.repo = s.update_repo.clone();
        match toml::to_string_pretty(&cfg) {
            Ok(text) => {
                let path = crate::config_path();
                let _ = std::fs::create_dir_all(path.parent().unwrap());
                match std::fs::write(&path, text) {
                    Ok(()) => self.activity(format!("settings saved to {}", path.display())),
                    Err(e) => self.activity(format!("settings save failed: {e}")),
                }
            }
            Err(e) => self.activity(format!("settings serialize failed: {e}")),
        }
        self.cfg = cfg;
    }

    /// Energy endpointing (§4.3): wait for speech (up to `start_timeout_ms`),
    /// then cut on trailing silence. Returns the PCM, whether real speech was
    /// heard, and the peak frame RMS (hallucination guard).
    fn capture_utterance(&mut self, start_timeout_ms: u64) -> (Vec<i16>, bool, f32) {
        let ep = self.cfg.endpoint.clone();
        let mut utterance: Vec<i16> = Vec::new();
        let mut seen_speech = false;
        let mut peak = 0.0f32;
        let mut silence_ms = 0u64;
        let mut waited_ms = 0u64;
        loop {
            let frame = self.read_frame();
            let energy = rms(&frame);
            peak = peak.max(energy);
            let loud = energy >= ep.energy_threshold;
            utterance.extend_from_slice(&frame);
            if loud {
                seen_speech = true;
                silence_ms = 0;
            } else if seen_speech {
                silence_ms += FRAME_MS;
                if silence_ms >= ep.silence_ms {
                    break;
                }
            } else {
                waited_ms += FRAME_MS;
                if waited_ms >= start_timeout_ms {
                    break;
                }
            }
            if utterance.len() as u64 >= 16 * ep.max_utterance_ms {
                break; // 16 samples per ms
            }
        }
        (utterance, seen_speech, peak)
    }

    /// Short rising two-tone blip confirming the wake word landed.
    fn chime(&mut self) {
        let rate = self.tts_rate as f32;
        let n = (rate * 0.14) as usize;
        let pcm: Vec<i16> = (0..n)
            .map(|i| {
                let t = i as f32 / rate;
                let f = if t < 0.07 { 880.0 } else { 1174.0 };
                let env = (1.0 - (i as f32 / n as f32)) * (i as f32 / 40.0).min(1.0);
                ((t * f * std::f32::consts::TAU).sin() * env * 9000.0) as i16
            })
            .collect();
        self.sink.play(&pcm, self.tts_rate);
    }

    /// Blocking read of one 80 ms frame from the capture ring.
    fn read_frame(&mut self) -> Vec<i16> {
        let mut buf = vec![0i16; FRAME];
        let mut filled = 0;
        while filled < FRAME {
            let n = self.source.read(&mut buf[filled..]);
            if n == 0 {
                std::thread::sleep(Duration::from_millis(5));
            }
            filled += n;
        }
        buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aria_core::fakes::*;

    /// Typed turn with fakes: history is fed to the LLM, both messages are
    /// persisted with timestamps, and the reply streams sentence events.
    #[test]
    fn typed_turn_persists_and_feeds_context() {
        let dir = std::env::temp_dir().join(format!("aria-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let hist = dir.join("history.jsonl");
        let (ev_tx, ev_rx) = std::sync::mpsc::channel();
        let (_cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        let (_playback, sink) = match aria_audio::Playback::start(48_000, 0.0) {
            Ok(v) => v,
            Err(_) => return, // no audio device (CI) — skip
        };
        let mut rt = Runtime {
            cfg: Config::default(),
            wake: Box::new(FakeWake::new(1)),
            stt: Box::new(FakeStt::new("x")),
            llm: Box::new(FakeLlm::new(&["Nice to meet you."])),
            llm_direct: None,
            tts: Box::new(FakeTts::default()),
            source: Box::new(FakeAudioSource::new(vec![])),
            sink,
            tts_rate: 24_000,
            events: ev_tx,
            cmds: Arc::new(Mutex::new(cmd_rx)),
            llm_failures: 0,
            llm_breaker_until: None,
            session: vec![ChatMsg::now("user", "earlier turn"), ChatMsg::now("assistant", "earlier reply")],
            history_path: hist.clone(),
            router: Router::new("auto", false),
            screen_share: false,
            requeue: Vec::new(),
        };
        rt.typed_turn("I'm Angel, remember that");
        // context: session should now be 4 msgs and the fake LLM saw the last user msg
        assert_eq!(rt.session.len(), 4);
        assert_eq!(rt.session[2].content, "I'm Angel, remember that");
        assert_eq!(rt.session[3].content, "Nice to meet you.");
        assert!(rt.session[3].at > 0, "timestamps recorded");
        // persistence: this turn's 2 messages were appended
        let lines = std::fs::read_to_string(&hist).unwrap();
        assert_eq!(lines.lines().count(), 2);
        // sentence event streamed
        let got: Vec<_> = ev_rx.try_iter().collect();
        assert!(got.iter().any(|e| matches!(e, UiEvent::Sentence(s) if s == "Nice to meet you.")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// LLM that panics — must not take the app down (§5.2 isolation).
    struct PanicLlm;
    impl aria_core::Llm for PanicLlm {
        fn complete(
            &mut self,
            _h: &[ChatMsg],
            _cb: &mut dyn FnMut(&str) -> bool,
        ) -> Result<(), aria_core::StageError> {
            panic!("segfault stand-in");
        }
    }

    fn test_runtime(llm: Box<dyn aria_core::Llm>) -> Option<Runtime> {
        let (ev_tx, _ev_rx) = std::sync::mpsc::channel();
        let (_cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        let (_playback, sink) = aria_audio::Playback::start(48_000, 0.0).ok()?;
        std::mem::forget(_playback); // keep stream alive for the test
        Some(Runtime {
            cfg: Config::default(),
            wake: Box::new(FakeWake::new(1)),
            stt: Box::new(FakeStt::new("x")),
            llm,
            llm_direct: None,
            tts: Box::new(FakeTts::default()),
            source: Box::new(FakeAudioSource::new(vec![])),
            sink,
            tts_rate: 24_000,
            events: ev_tx,
            cmds: Arc::new(Mutex::new(cmd_rx)),
            llm_failures: 0,
            llm_breaker_until: None,
            session: Vec::new(),
            history_path: std::env::temp_dir().join(format!("aria-h-{:?}.jsonl", std::thread::current().id())),
            router: Router::new("auto", false),
            screen_share: false,
            requeue: Vec::new(),
        })
    }

    #[test]
    fn llm_panic_is_contained_and_spoken_apology_flows() {
        let Some(mut rt) = test_runtime(Box::new(PanicLlm)) else { return };
        // Must not propagate the panic; failure counts toward the breaker.
        rt.typed_turn("hello");
        assert_eq!(rt.llm_failures, 1);
        let _ = std::fs::remove_file(&rt.history_path);
    }

    #[test]
    fn breaker_opens_after_threshold_and_fast_fails() {
        let Some(mut rt) = test_runtime(Box::new(PanicLlm)) else { return };
        for _ in 0..rt.cfg.health.breaker_failure_threshold {
            rt.typed_turn("q");
        }
        assert!(rt.llm_breaker_until.is_some(), "breaker should be open");
        // While open, respond() fast-fails without touching the LLM.
        let (spoke, interrupt) = rt.respond("again", None);
        assert!(interrupt.is_none());
        let _ = spoke; // apology may or may not synth via FakeTts (empty pcm ok)
        assert!(rt.llm_breaker_until.is_some());
        let _ = std::fs::remove_file(&rt.history_path);
    }

    #[test]
    fn hallucination_guard_edges() {
        // quiet + classic filler → dropped
        assert!(is_hallucination("Thank you.", 300.0, 500.0));
        assert!(is_hallucination("thanks for watching!", 100.0, 500.0));
        // loud audio → always trusted
        assert!(!is_hallucination("Thank you.", 1200.0, 500.0));
        // quiet but substantive → trusted
        assert!(!is_hallucination("turn off the lights in the kitchen", 300.0, 500.0));
    }
}
