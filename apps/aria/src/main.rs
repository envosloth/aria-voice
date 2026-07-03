//! ARIA v3 binary: Glass Observatory UI + native voice pipeline.
//!
//! Usage:
//!   aria [config.toml]        UI + voice assistant (default)
//!   aria --headless           voice loop only, no window\n//!   aria --toggle | --quit    control a running instance
//!   aria --say "text"         synthesize text through Piper to the speaker
//!   aria --ask "q"            one LLM+TTS round-trip, no mic
//!   aria --loop-fakes         M0 fake-engine loop (no models, no devices)

mod hardware;
mod router;
mod runtime;
mod screen;
mod updater;

use std::sync::mpsc;

use aria_audio::{Capture, Playback};
use aria_core::{ChatMsg, Config};
use aria_llm::GatewayLlm;
use aria_stt::WhisperStt;
use aria_tts::AnyTts;
use aria_ui::{Settings, UiCommand, UiEvent};
use aria_wake::OnnxWake;
use runtime::Runtime;

pub fn config_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join(".config/aria/aria.toml")
}

pub fn history_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join(".local/share/aria/history.jsonl")
}

/// Last `n` messages of the persisted session history. Rotates the file
/// down to 200 lines once it passes 400 so it can't grow forever.
fn load_history(n: usize) -> Vec<ChatMsg> {
    let path = history_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() > 400 {
        let keep = lines[lines.len() - 200..].join("\n");
        let _ = std::fs::write(&path, format!("{keep}\n"));
    }
    let mut msgs: Vec<ChatMsg> = lines
        .iter()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if msgs.len() > n {
        msgs.drain(..msgs.len() - n);
    }
    msgs
}

fn load_config(path: Option<&str>) -> Config {
    match path {
        Some(p) => Config::load(std::path::Path::new(p)).unwrap_or_else(|e| {
            eprintln!("config error: {e}");
            std::process::exit(1);
        }),
        None => {
            let default = config_path();
            if default.exists() {
                Config::load(&default).unwrap_or_else(|e| {
                    eprintln!("config error in {}: {e}", default.display());
                    std::process::exit(1);
                })
            } else {
                Config::default()
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--loop-fakes") => return fake_loop(),
        Some("--say") => {
            let text = args.get(1).cloned().unwrap_or_else(|| "Hello from ARIA.".into());
            return say(&load_config(None), &text);
        }
        Some("--ask") => {
            let text = args.get(1).cloned().unwrap_or_else(|| "Introduce yourself briefly.".into());
            return ask(&load_config(None), &text);
        }
        _ => {}
    }

    match args.first().map(String::as_str) {
        Some("--toggle") => {
            if signal_running_instance(b"toggle") {
                return; // running instance toggled its window
            }
            // no instance yet — fall through and start normally
        }
        Some("--quit") => {
            let _ = signal_running_instance(b"quit");
            return;
        }
        _ => {}
    }

    let headless = args.first().map(String::as_str) == Some("--headless");
    let cfg_arg = args.iter().find(|a| !a.starts_with("--")).cloned();
    let cfg = load_config(cfg_arg.as_deref());

    let (ev_tx, ev_rx) = mpsc::channel::<UiEvent>();
    let (cmd_tx, cmd_rx) = mpsc::channel::<UiCommand>();
    start_instance_socket(ev_tx.clone());

    let hw = hardware::resolve(&cfg);
    let settings = Settings {
        endpoint: cfg.llm.endpoint.clone(),
        model: cfg.llm.model.clone(),
        api_key: cfg.llm.api_key.clone(),
        routing: cfg.llm.routing.clone(),
        direct_endpoint: cfg.llm.direct_endpoint.clone(),
        direct_model: cfg.llm.direct_model.clone(),
        direct_api_key: cfg.llm.direct_api_key.clone(),
        voice: cfg.tts.voice.clone(),
        tts_speed: cfg.tts.speed,
        volume: cfg.tts.volume,
        orb_speed: 1.0,
        orb_glow: 1.0,
        wake_phrase: cfg.wake.phrase.clone(),
        wake_threshold: cfg.wake.threshold,
        energy_threshold: cfg.endpoint.energy_threshold,
        silence_ms: cfg.endpoint.silence_ms,
        followup_ms: cfg.endpoint.followup_window_ms,
        preset: cfg.perf.preset.clone(),
        stt_model: cfg.stt.model.clone(),
        hw_info: format!(
            "{} preset · {} · {} threads · {}",
            hw.preset,
            hw.stt_model,
            hw.stt_threads,
            if hw.gpu { "GPU (Vulkan)" } else { "CPU only" }
        ),
        update_repo: cfg.update.repo.clone(),
    };
    let endpoint_label = if cfg.llm.endpoint.contains("127.0.0.1") || cfg.llm.endpoint.contains("localhost") {
        "Hermes Gateway".to_string()
    } else {
        cfg.llm.endpoint.replace("http://", "").replace("https://", "")
    };

    install_panic_log();
    let history = load_history(40);

    // Voice pipeline on its own thread with a restart guard (§5.3): a panic
    // rebuilds the engines with backoff instead of killing the assistant.
    let voice_cfg = cfg.clone();
    let voice_history = history.clone();
    let cmd_rx = std::sync::Arc::new(std::sync::Mutex::new(cmd_rx));
    let voice = std::thread::Builder::new()
        .name("voice-pipeline".into())
        .spawn(move || {
            let mut backoff_s = 1u64;
            loop {
                let cfg = voice_cfg.clone();
                let history = load_history(40); // fresh after any prior turns
                let history = if history.is_empty() { voice_history.clone() } else { history };
                let ev = ev_tx.clone();
                let cmds = cmd_rx.clone();
                let crashed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    voice_thread(cfg, history, ev, cmds)
                }))
                .is_err();
                if !crashed {
                    return; // clean exit (fatal init error already reported)
                }
                let _ = ev_tx.send(UiEvent::Activity(format!(
                    "voice pipeline crashed — restarting in {backoff_s}s"
                )));
                std::thread::sleep(std::time::Duration::from_secs(backoff_s));
                backoff_s = (backoff_s * 2).min(30); // guarded backoff (A-6 lesson)
            }
        })
        .expect("spawn voice thread");

    if headless {
        let _ = voice.join();
        return;
    }

    // UI owns the main thread (winit requirement); process exit stops voice.
    if let Err(e) = aria_ui::run_ui(ev_rx, cmd_tx, settings, endpoint_label, history) {
        eprintln!("ui error: {e}");
    }
    std::process::exit(0); // §5.3: in-process threads die with the process
}

fn socket_path() -> std::path::PathBuf {
    let dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    std::path::Path::new(&dir).join("aria.sock")
}

/// Send a control message to a running instance ("toggle" / "quit").
/// Returns false when no instance is listening.
fn signal_running_instance(msg: &[u8]) -> bool {
    use std::io::Write;
    match std::os::unix::net::UnixStream::connect(socket_path()) {
        Ok(mut s) => {
            let _ = s.write_all(msg);
            true
        }
        Err(_) => false,
    }
}

/// Single-instance socket: any connection toggles the window (the global
/// Alt+Shift+Space shortcut runs `aria --toggle` — Wayland-safe, A-17).
fn start_instance_socket(events: mpsc::Sender<UiEvent>) {
    let path = socket_path();
    let _ = std::fs::remove_file(&path); // stale socket from a crash
    let Ok(listener) = std::os::unix::net::UnixListener::bind(&path) else {
        return; // second instance without --toggle: run standalone
    };
    std::thread::Builder::new()
        .name("instance-socket".into())
        .spawn(move || {
            use std::io::Read;
            for mut conn in listener.incoming().flatten() {
                let mut buf = [0u8; 16];
                let _ = conn.set_read_timeout(Some(std::time::Duration::from_millis(200)));
                let n = conn.read(&mut buf).unwrap_or(0);
                if &buf[..n] == b"quit" {
                    // Never route quit through the render loop: Wayland can
                    // stall it for occluded windows, deadlocking shutdown.
                    println!("quit requested — exiting");
                    std::process::exit(0);
                }
                let _ = events.send(UiEvent::ToggleWindow);
                aria_ui::ping_ui(); // wake a compositor-idled render loop
            }
        })
        .ok();
}

/// Every panic lands in ~/.local/share/aria/aria.log with a timestamp, then
/// falls through to the default stderr hook.
fn install_panic_log() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let home = std::env::var("HOME").unwrap_or_default();
        let dir = std::path::Path::new(&home).join(".local/share/aria");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("aria.log"))
        {
            use std::io::Write;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{ts}] panic: {info}");
        }
        default(info);
    }));
}

fn voice_thread(
    cfg: Config,
    history: Vec<ChatMsg>,
    events: mpsc::Sender<UiEvent>,
    cmds: std::sync::Arc<std::sync::Mutex<mpsc::Receiver<UiCommand>>>,
) {
    let models = cfg.models.expanded_dir();
    let fail = |stage: &str, err: String, events: &mpsc::Sender<UiEvent>| {
        eprintln!("{stage}: {err}");
        let _ = events.send(UiEvent::Activity(format!("{stage} failed: {err}")));
    };

    let wake = match OnnxWake::new(
        &models,
        &format!("{}_v0.1.onnx", cfg.wake.phrase),
        cfg.wake.threshold,
        cfg.wake.cooldown_ms,
    ) {
        Ok(w) => w,
        Err(e) => return fail("wake", e.to_string(), &events),
    };
    let hw = hardware::resolve(&cfg);
    let _ = events.send(UiEvent::Activity(format!(
        "preset {} · stt {} · {} threads · gpu {}",
        hw.preset, hw.stt_model, hw.stt_threads, if hw.gpu { "yes" } else { "no" }
    )));
    let stt = match WhisperStt::new(
        &models.join(format!("ggml-{}.bin", hw.stt_model)),
        hw.stt_threads,
    ) {
        Ok(s) => s,
        Err(e) => return fail("stt", e.to_string(), &events),
    };
    let mut tts = match AnyTts::load(&models, &cfg.tts.voice, cfg.tts.speed) {
        Ok(t) => t,
        Err(e) => return fail("tts", e.to_string(), &events),
    };
    let llm = GatewayLlm::new(&cfg.llm.endpoint, &cfg.llm.api_key, &cfg.llm.model);
    // Mixture mode: optional direct (tool-less) LLM with the anti-confab prompt.
    let llm_direct: Option<Box<dyn aria_core::Llm>> = if cfg.llm.direct_endpoint.is_empty() {
        None
    } else {
        Some(Box::new(
            GatewayLlm::new(
                &cfg.llm.direct_endpoint,
                &cfg.llm.direct_api_key,
                &cfg.llm.direct_model,
            )
            .with_system_prompt(aria_llm::DIRECT_SYSTEM_PROMPT),
        ))
    };
    let router = router::Router::new(&cfg.llm.routing, llm_direct.is_some());

    // Warm the engine (espeak init + first inference) so replies start fast (B-2).
    use aria_core::Tts as _;
    let _ = tts.synth("ready");
    let tts_rate = tts.sample_rate();

    let (_capture, source) = match Capture::start(cfg.audio.capture_ring_samples) {
        Ok(v) => v,
        Err(e) => return fail("capture", e.to_string(), &events),
    };
    let (_playback, sink) = match Playback::start(
        cfg.audio.capture_ring_samples,
        cfg.audio.master_volume * cfg.tts.volume,
    ) {
        Ok(v) => v,
        Err(e) => return fail("playback", e.to_string(), &events),
    };

    println!(
        "ARIA v3 — models={} llm={} voice={}",
        models.display(),
        cfg.llm.endpoint,
        cfg.tts.voice
    );

    spawn_rss_watchdog(cfg.health.memory_ceiling_mb, events.clone());

    Runtime {
        cfg,
        wake: Box::new(wake),
        stt: Box::new(stt),
        llm: Box::new(llm),
        llm_direct,
        tts: Box::new(tts),
        source: Box::new(source),
        sink,
        tts_rate,
        events,
        cmds,
        llm_failures: 0,
        llm_breaker_until: None,
        session: history,
        history_path: history_path(),
        router,
        screen_share: false,
        requeue: Vec::new(),
    }
    .run();
}

/// §5.4 RSS watchdog. ponytail: warn-only for now — per-component graceful
/// restart is the M3 follow-up; the ceiling breach is at least visible.
fn spawn_rss_watchdog(ceiling_mb: u64, events: mpsc::Sender<UiEvent>) {
    if !cfg!(target_os = "linux") {
        return;
    }
    std::thread::Builder::new()
        .name("rss-watchdog".into())
        .spawn(move || {
            let mut warned = false;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(10));
                let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
                    continue;
                };
                let rss_mb = status
                    .lines()
                    .find(|l| l.starts_with("VmRSS:"))
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|kb| kb.parse::<u64>().ok())
                    .map(|kb| kb / 1024)
                    .unwrap_or(0);
                if rss_mb > ceiling_mb && !warned {
                    warned = true;
                    let _ = events.send(UiEvent::Activity(format!(
                        "memory watchdog: RSS {rss_mb} MB over {ceiling_mb} MB ceiling"
                    )));
                } else if rss_mb < ceiling_mb * 9 / 10 {
                    warned = false; // re-arm below 90% of ceiling
                }
            }
        })
        .ok();
}

fn fatal(stage: &str, err: &str) -> ! {
    eprintln!("{stage}: {err}");
    std::process::exit(1);
}

fn say(cfg: &Config, text: &str) {
    use aria_core::Tts as _;
    let models = cfg.models.expanded_dir();
    let mut tts = AnyTts::load(&models, &cfg.tts.voice, cfg.tts.speed)
        .unwrap_or_else(|e| fatal("tts", &e.to_string()));
    let pcm = tts.synth(text).unwrap_or_else(|e| fatal("synth", &e.to_string()));
    let rate = tts.sample_rate();
    let (_playback, mut sink) =
        Playback::start(rate as usize * 30, cfg.audio.master_volume * cfg.tts.volume)
            .unwrap_or_else(|e| fatal("playback", &e.to_string()));
    println!("speaking {} samples at {} Hz", pcm.len(), rate);
    sink.play(&pcm, rate);
    while sink.queued() > 0 {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    std::thread::sleep(std::time::Duration::from_millis(200)); // let the device drain
}

/// Text question → live gateway (SSE) → Piper → speaker. The voice loop
/// minus the microphone; verifies LLM + TTS + playback end-to-end.
fn ask(cfg: &Config, text: &str) {
    use aria_core::{Llm as _, Tts as _};
    let models = cfg.models.expanded_dir();
    let mut tts = AnyTts::load(&models, &cfg.tts.voice, cfg.tts.speed)
        .unwrap_or_else(|e| fatal("tts", &e.to_string()));
    let _ = tts.synth("warm");
    let rate = tts.sample_rate();
    let (_playback, mut sink) =
        Playback::start(rate as usize * 60, cfg.audio.master_volume * cfg.tts.volume)
            .unwrap_or_else(|e| fatal("playback", &e.to_string()));
    let mut llm = GatewayLlm::new(&cfg.llm.endpoint, &cfg.llm.api_key, &cfg.llm.model);
    let t0 = std::time::Instant::now();
    let mut first: Option<u128> = None;
    let history = [ChatMsg::now("user", text)];
    llm.complete(&history, &mut |sentence| {
        println!("· {sentence}");
        if let Ok(pcm) = tts.synth(sentence) {
            first.get_or_insert_with(|| t0.elapsed().as_millis());
            sink.play(&pcm, rate);
        }
        true
    })
    .unwrap_or_else(|e| fatal("llm", &e.to_string()));
    if let Some(ms) = first {
        println!("· first audio: {ms} ms");
    }
    while sink.queued() > 0 {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    std::thread::sleep(std::time::Duration::from_millis(200));
}

fn fake_loop() {
    use aria_core::fakes::*;
    use aria_core::pipeline::{run_turn, Engines};
    use aria_core::Fsm;
    let mut wake = FakeWake::new(3);
    let mut stt = FakeStt::new("hey jarvis what time is it");
    let mut llm = FakeLlm::new(&["It is two in the afternoon.", "Need anything else?"]);
    let mut tts = FakeTts::default();
    let mut source = FakeAudioSource::new(vec![100i16; 1280 * 5]);
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
    .expect("fake turn cannot fail")
    .expect("wake fires in fake stream");
    println!("states: {:?}", log.states);
    println!("heard:  {:?}", log.transcript);
    println!("spoke:  {:?}", log.reply_sentences);
    println!("M0 loop OK");
}
