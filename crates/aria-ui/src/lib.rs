//! Glass Observatory UI — the Harness Concepts design (turn 4a) in native
//! egui. Pure view (spec §2.5): state arrives as `UiEvent`s, intent leaves as
//! `UiCommand`s; the voice runtime never waits on this thread (A-2).

use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use aria_orb::{params_for, radial_fan, state_hue_color, Orb, OrbParams, OrbState};
use egui::{
    Align, Color32, CornerRadius, FontData, FontFamily, FontId, Frame, Layout, Margin, RichText,
    Stroke,
};

// ------------------------------------------------------------- protocol --

#[derive(Debug, Clone)]
pub enum UiEvent {
    /// Orb state + badge label ("SPEAKING · STREAMING").
    State(OrbState, String),
    /// Final transcript of the user's spoken utterance.
    Heard(String),
    /// One streamed reply sentence.
    Sentence(String),
    /// Reply finished (stops the streaming cursor).
    TurnDone,
    /// Timestamped ops-panel line.
    Activity(String),
    /// Gateway reachability (sidebar endpoint dot).
    Gateway(bool),
    /// Per-stage latency for the perf section (§6.7), timed from audio_end (A-16).
    Perf(String, u128),
    /// Bring the window back (wake word while hidden).
    Show,
    /// Screen-share state changed (runtime-confirmed).
    ScreenShare(bool),
    /// Toggle window visibility (global hotkey / second `aria --toggle`).
    ToggleWindow,
    /// Really exit the app (`aria --quit` / sidebar Quit / Ctrl+Q).
    Quit,
}

#[derive(Debug, Clone)]
pub enum UiCommand {
    /// Typed message — answered with LLM + TTS like a spoken one.
    Ask(String),
    /// Force a wake (mic button = Wayland-safe hotkey fallback, A-17).
    Wake,
    /// Stop speech now (barge-in from UI).
    Stop,
    SetVolume(f32),
    SetSpeed(f32),
    /// Switch TTS voice live; the runtime speaks a short preview.
    SetVoice(String),
    /// Toggle screen share (button or voice does the same).
    ScreenShare(bool),
    /// Check GitHub releases and self-update with progress.
    CheckUpdate,
    SaveSettings(Settings),
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub endpoint: String,
    pub model: String,
    pub api_key: String,
    /// Mixture mode: "auto" | "harness" | "direct".
    pub routing: String,
    pub direct_endpoint: String,
    pub direct_model: String,
    pub direct_api_key: String,
    pub voice: String,
    pub tts_speed: f32,
    pub volume: f32,
    pub orb_speed: f32,
    pub orb_glow: f32,
    pub wake_phrase: String,
    pub wake_threshold: f32,
    pub energy_threshold: f32,
    pub silence_ms: u64,
    /// Follow-up listening window after a reply (0 = off).
    pub followup_ms: u64,
    /// "auto" | "eco" | "balanced" | "performance".
    pub preset: String,
    /// "auto" | explicit ggml stem.
    pub stt_model: String,
    /// Display-only: what the hardware probe resolved to.
    pub hw_info: String,
    pub update_repo: String,
}

/// Voice choices shown in settings — 4 Kokoro voices + the Piper fallback.
pub const VOICE_CHOICES: &[(&str, &str)] = &[
    ("bm_george", "George — British male (Jarvis)"),
    ("af_heart", "Heart — US female"),
    ("af_bella", "Bella — US female"),
    ("am_michael", "Michael — US male"),
    ("en_GB-alan-medium", "Alan — Piper fallback"),
];

// ---------------------------------------------------------------- theme --

const BG: Color32 = Color32::from_rgb(4, 6, 11);
const TEXT: Color32 = Color32::from_rgb(233, 237, 245);

fn text_dim(a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(233, 237, 245, a)
}

fn white_a(a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(255, 255, 255, a)
}

/// Glass pane: translucent fill + border + specular top edge (design 4a's
/// "gradient panes, specular edges").
fn glass_show(ui: &mut egui::Ui, margin: Margin, add: impl FnOnce(&mut egui::Ui)) {
    let r = Frame::new()
        .fill(white_a(11))
        .stroke(Stroke::new(1.0, white_a(38)))
        .corner_radius(CornerRadius::same(22))
        .inner_margin(margin)
        .show(ui, add);
    let rect = r.response.rect;
    let p = ui.painter();
    // inset specular highlight along the top edge
    p.line_segment(
        [
            egui::pos2(rect.left() + 22.0, rect.top() + 1.5),
            egui::pos2(rect.right() - 22.0, rect.top() + 1.5),
        ],
        Stroke::new(1.0, white_a(56)),
    );
    // faint darker line along the bottom (inset 0 -1px rgba(0,0,0,.4))
    p.line_segment(
        [
            egui::pos2(rect.left() + 22.0, rect.bottom() - 1.5),
            egui::pos2(rect.right() - 22.0, rect.bottom() - 1.5),
        ],
        Stroke::new(1.0, Color32::from_rgba_unmultiplied(0, 0, 0, 90)),
    );
}

/// Base + bloom blobs + 48px grid behind the glass panes.
fn paint_backdrop(ui: &egui::Ui, state: OrbState) {
    let rect = ui.max_rect();
    let p = ui.painter();
    p.rect_filled(rect, 0.0, BG);
    let blob = |cx: f32, cy: f32, r: f32, c: Color32, a: u8| {
        radial_fan(
            p,
            egui::pos2(rect.left() + cx * rect.width(), rect.top() + cy * rect.height()),
            r,
            &[
                (0.0, Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)),
                (0.62, Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a / 3)),
                (1.0, Color32::TRANSPARENT),
            ],
        );
    };
    // Clean backdrop: colored bloom on near-black, no texture. The top-right
    // blob follows the orb state hue so the room "lights up" with the state.
    let accent = state_hue_color(state);
    blob(0.78, 0.02, 380.0, accent, 34);
    blob(-0.02, 0.6, 320.0, Color32::from_rgb(150, 100, 235), 26);
    blob(0.5, 1.05, 360.0, Color32::from_rgb(90, 140, 235), 20);
}

fn mono(size: f32) -> FontId {
    FontId::new(size, FontFamily::Monospace)
}

fn sans(size: f32) -> FontId {
    FontId::new(size, FontFamily::Proportional)
}

// ------------------------------------------------------------------ app --

#[derive(PartialEq)]
enum Role {
    User,
    Assistant,
    Tool,
}

struct Msg {
    role: Role,
    text: String,
    done: bool,
    /// Wall-clock send time, "HH:MM".
    at: String,
}

/// Render-loop waker: lets non-UI threads force a repaint so events get
/// drained even when the compositor has idled the window (Wayland stalls
/// frame callbacks for occluded surfaces — A-2 for the UI side).
static UI_CTX: std::sync::OnceLock<egui::Context> = std::sync::OnceLock::new();

pub fn ping_ui() {
    if let Some(ctx) = UI_CTX.get() {
        ctx.request_repaint();
    }
}

pub fn run_ui(
    events: Receiver<UiEvent>,
    cmds: Sender<UiCommand>,
    settings: Settings,
    endpoint_label: String,
    history: Vec<aria_core::ChatMsg>,
) -> Result<(), eframe::Error> {
    let opts = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1360.0, 840.0])
            .with_min_inner_size([980.0, 620.0])
            .with_title("ARIA — Harness"),
        ..Default::default()
    };
    eframe::run_native(
        "aria-harness",
        opts,
        Box::new(move |cc| {
            let _ = UI_CTX.set(cc.egui_ctx.clone());
            install_fonts(&cc.egui_ctx);
            cc.egui_ctx.set_visuals(egui::Visuals::dark());
            Ok(Box::new(App::new(events, cmds, settings, endpoint_label, history)))
        }),
    )
}

/// Local-time "HH:MM" from a unix timestamp. ponytail: shells `date` once for
/// the UTC offset instead of pulling in chrono; DST changes need an app restart.
fn fmt_hhmm(epoch_s: u64) -> String {
    thread_local! {
        static OFFSET: i64 = std::process::Command::new("date")
            .arg("+%z")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| {
                let s = s.trim();
                let sign = if s.starts_with('-') { -1 } else { 1 };
                let h: i64 = s.get(1..3)?.parse().ok()?;
                let m: i64 = s.get(3..5)?.parse().ok()?;
                Some(sign * (h * 3600 + m * 60))
            })
            .unwrap_or(0);
    }
    let local = epoch_s as i64 + OFFSET.with(|o| *o);
    format!("{:02}:{:02}", (local / 3600) % 24, (local / 60) % 60)
}

fn now_hhmm() -> String {
    fmt_hhmm(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    )
}

fn install_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert(
        "grotesk".into(),
        std::sync::Arc::new(FontData::from_static(include_bytes!("../assets/SpaceGrotesk.ttf"))),
    );
    fonts.font_data.insert(
        "plex".into(),
        std::sync::Arc::new(FontData::from_static(include_bytes!(
            "../assets/IBMPlexMono-Regular.ttf"
        ))),
    );
    fonts
        .families
        .get_mut(&FontFamily::Proportional)
        .unwrap()
        .insert(0, "grotesk".into());
    fonts
        .families
        .get_mut(&FontFamily::Monospace)
        .unwrap()
        .insert(0, "plex".into());
    ctx.set_fonts(fonts);
}

struct App {
    events: Receiver<UiEvent>,
    cmds: Sender<UiCommand>,
    settings: Settings,
    endpoint_label: String,
    gateway_up: Option<bool>,

    t0: Instant,
    orb: Orb,
    state: OrbState,
    orb_p: OrbParams,
    motion_t: f32,
    hidden: bool,
    badge: String,
    msgs: Vec<Msg>,
    activity: VecDeque<(String, String, bool)>, // time, text, highlight
    perf: Vec<(String, u128)>,                  // stage → ms, last turn
    timeline: VecDeque<(Instant, OrbState)>,
    input: String,
    settings_open: bool,
    settings_tab: usize,
    last_frame: Instant,
    fps_ema: f32,
    screen_share: bool,
    /// Set when the user really wants to exit (vs. hide-to-background).
    really_quit: bool,
}

impl App {
    fn new(
        events: Receiver<UiEvent>,
        cmds: Sender<UiCommand>,
        settings: Settings,
        endpoint_label: String,
        history: Vec<aria_core::ChatMsg>,
    ) -> Self {
        let mut activity = VecDeque::new();
        activity.push_front((clock(), "harness ready".to_string(), false));
        let mut timeline = VecDeque::new();
        timeline.push_back((Instant::now(), OrbState::Idle));
        let msgs = history
            .into_iter()
            .map(|m| Msg {
                role: if m.role == "user" { Role::User } else { Role::Assistant },
                text: m.content,
                done: true,
                at: fmt_hhmm(m.at),
            })
            .collect();
        Self {
            events,
            cmds,
            settings,
            endpoint_label,
            gateway_up: None,
            t0: Instant::now(),
            orb: Orb::new("hero", 250.0),
            state: OrbState::Idle,
            orb_p: params_for(OrbState::Idle),
            motion_t: 0.0,
            hidden: false,
            badge: "IDLE · STANDING BY".into(),
            msgs,
            activity,
            perf: Vec::new(),
            timeline,
            input: String::new(),
            settings_open: false,
            settings_tab: 0,
            last_frame: Instant::now(),
            fps_ema: 60.0,
            screen_share: false,
            really_quit: false,
        }
    }

    fn log(&mut self, text: &str, highlight: bool) {
        self.activity.push_front((clock(), text.to_string(), highlight));
        self.activity.truncate(8);
    }

    fn drain_events(&mut self) {
        while let Ok(ev) = self.events.try_recv() {
            match ev {
                UiEvent::State(s, label) => {
                    self.state = s;
                    self.badge = label;
                    self.timeline.push_back((Instant::now(), s));
                    while self.timeline.len() > 240 {
                        self.timeline.pop_front();
                    }
                }
                UiEvent::Heard(t) => {
                    self.log("utterance transcribed", false);
                    self.msgs.push(Msg { role: Role::User, text: t, done: true, at: now_hhmm() });
                }
                UiEvent::Sentence(s) => match self.msgs.last_mut() {
                    Some(m) if m.role == Role::Assistant && !m.done => {
                        m.text.push(' ');
                        m.text.push_str(&s);
                    }
                    _ => {
                        self.log("streaming response", true);
                        self.msgs.push(Msg {
                            role: Role::Assistant,
                            text: s,
                            done: false,
                            at: now_hhmm(),
                        });
                    }
                },
                UiEvent::TurnDone => {
                    if let Some(m) = self.msgs.last_mut() {
                        m.done = true;
                    }
                }
                UiEvent::Activity(t) => self.log(&t, false),
                UiEvent::Gateway(up) => self.gateway_up = Some(up),
                UiEvent::Perf(stage, ms) => {
                    if stage == "stt" {
                        self.perf.clear(); // new turn starts the row over
                    }
                    self.perf.retain(|(s, _)| *s != stage);
                    self.perf.push((stage, ms));
                }
                UiEvent::Show => self.hidden = false,
                UiEvent::ToggleWindow => self.hidden = !self.hidden,
                UiEvent::Quit => self.really_quit = true,
                UiEvent::ScreenShare(on) => self.screen_share = on,
            }
        }
    }

    fn send(&mut self, cmd: UiCommand) {
        let _ = self.cmds.send(cmd);
    }

    /// True while a reply is streaming or being spoken.
    fn speaking(&self) -> bool {
        matches!(self.state, OrbState::Speaking | OrbState::Tools)
            || self.msgs.last().is_some_and(|m| m.role == Role::Assistant && !m.done)
    }

    fn submit_input(&mut self) {
        let text = self.input.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.input.clear();
        // Typed wake word: chat-bar fallback when the spoken wake fails.
        let phrase = self.settings.wake_phrase.replace('_', " ").to_lowercase();
        let t = text.to_lowercase();
        if t == phrase || t == "wake" || (!phrase.is_empty() && phrase.contains(&t) && t.len() > 3)
        {
            self.send(UiCommand::Wake);
            self.log("wake (typed)", false);
            return;
        }
        self.msgs.push(Msg { role: Role::User, text: text.clone(), done: true, at: now_hhmm() });
        self.log("user message (typed)", false);
        self.send(UiCommand::Ask(text));
    }
}

fn clock() -> String {
    // Session-relative HH:MM:SS — avoids a timezone dep. ponytail: wall clock
    // needs chrono; session time reads the same in the activity feed.
    thread_local! {
        static T0: Instant = Instant::now();
    }
    let s = T0.with(|t| t.elapsed().as_secs());
    format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let was_hidden = self.hidden;
        self.drain_events();
        let dt = self.last_frame.elapsed().as_secs_f32().clamp(1e-4, 0.1);
        self.last_frame = Instant::now();
        self.fps_ema = 0.95 * self.fps_ema + 0.05 / dt;

        // Orb dynamics: glide toward the state's params; while the agent is
        // actually speaking, amp/flare/spin ride the live playback RMS so the
        // core and debris move with the voice — and only then (§6.6).
        let mut target = params_for(self.state);
        let react = (aria_core::meter::get() * 4.5).min(1.0);
        if self.state == OrbState::Speaking && react > 0.02 {
            target.amp = 0.5 + 1.3 * react;
            target.flare = 0.55 + 1.25 * react;
            target.spd = 0.6 + 0.7 * react;
        }
        let k = 1.0 - (-dt / 1.1f32).exp(); // ~1.1 s time constant — smooth, never snaps
        let l = |a: f32, b: f32| a + (b - a) * k;
        let p = &mut self.orb_p;
        p.spd = l(p.spd, target.spd);
        p.amp = l(p.amp, target.amp);
        p.flare = l(p.flare, target.flare);
        for i in 0..3 {
            p.e[i] = l(p.e[i], target.e[i]);
            p.hh[i] = l(p.hh[i], target.hh[i]);
        }
        // Phase accumulation: speed changes glide, the angle never jumps.
        self.motion_t += dt * self.orb_p.spd * self.settings.orb_speed;
        let ctx = ui.ctx().clone();

        // Escape interrupts the agent mid-speech.
        if ctx.input(|i| i.key_pressed(egui::Key::Escape)) && self.speaking() {
            self.send(UiCommand::Stop);
            self.log("interrupted (esc)", false);
        }

        // Ctrl+Q / Cmd+Q always quits for real.
        if ctx.input(|i| i.modifiers.command && i.key_pressed(egui::Key::Q)) {
            self.really_quit = true;
        }
        if self.really_quit {
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        // Background mode: closing hides the window, the app keeps listening.
        // Wake word / --toggle / hotkey bring it back. Quit for real via the
        // sidebar Quit button, Ctrl+Q, or `aria --quit`.
        if ctx.input(|i| i.viewport().close_requested()) && !self.really_quit {
            ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
            self.hidden = true;
            self.log("running in background — Quit via sidebar or Ctrl+Q", false);
        }
        if self.hidden != was_hidden {
            // Minimize, don't unmap: Visible(false) corrupts the surface on
            // Wayland (GUI came back broken after closing to background).
            ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(self.hidden));
            if !self.hidden {
                ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
            }
        }

        // A-1: cap the render loop; throttle hard when unfocused.
        let focused = ctx.input(|i| i.focused);
        ctx.request_repaint_after(Duration::from_millis(if focused { 16 } else { 250 }));

        ctx.all_styles_mut(|s| {
            // Labels must not grab clicks or show the I-beam — they were
            // eating card/button clicks and breaking the cursor.
            s.interaction.selectable_labels = false;
            s.visuals.override_text_color = Some(TEXT);
            s.visuals.panel_fill = Color32::TRANSPARENT;
            s.visuals.window_fill = Color32::from_rgb(16, 20, 30);
            s.visuals.extreme_bg_color = white_a(10);
        });

        // Backdrop: base + colored bloom + 48px grid (design 4a). Panels are
        // translucent glass over this — blur of a smooth gradient is the
        // gradient, so this reads as backdrop blur without a blur pass.
        paint_backdrop(ui, self.state);

        let outer = Frame::new().inner_margin(Margin::same(16));

        egui::Panel::left(egui::Id::new("sidebar"))
            .exact_size(240.0)
            .resizable(false)
            .frame(outer)
            .show(ui, |ui| {
                glass_show(ui, Margin::same(14), |ui| self.sidebar(ui));
            });

        egui::Panel::right(egui::Id::new("ops"))
            .exact_size(360.0)
            .resizable(false)
            .frame(Frame::new().inner_margin(Margin {
                left: 0,
                right: 16,
                top: 16,
                bottom: 16,
            }))
            .show(ui, |ui| {
                glass_show(ui, Margin::same(14), |ui| self.ops(ui));
            });

        egui::CentralPanel::default()
            .frame(Frame::new().inner_margin(Margin {
                left: 0,
                right: 16,
                top: 16,
                bottom: 16,
            }))
            .show(ui, |ui| {
                glass_show(ui, Margin::same(0), |ui| self.chat(ui));
            });

        if self.settings_open {
            self.settings_modal(&ctx);
        }
    }
}

impl App {
    // ---------------------------------------------------------- sidebar --
    fn sidebar(&mut self, ui: &mut egui::Ui) {
        ui.set_min_height(ui.available_height());
        ui.horizontal(|ui| {
            let (r, p) = ui.allocate_painter(egui::vec2(20.0, 20.0), egui::Sense::hover());
            p.rect_filled(r.rect, 6.0, Color32::from_rgb(64, 200, 220));
            p.rect_filled(
                egui::Rect::from_min_max(r.rect.center(), r.rect.max),
                CornerRadius { nw: 0, ne: 0, sw: 0, se: 6 },
                Color32::from_rgb(150, 100, 235),
            );
            ui.label(RichText::new("HARNESS").font(mono(12.0)).strong());
        });
        ui.add_space(6.0);
        ui.separator();

        section_label(ui, "ENDPOINTS");
        let (dot, status) = match self.gateway_up {
            Some(true) => (Color32::from_rgb(64, 220, 235), "LIVE"),
            Some(false) => (Color32::from_rgb(235, 100, 90), "DOWN"),
            None => (Color32::from_rgb(120, 200, 140), "RDY"),
        };
        row_card(ui, true, |ui| {
            dot_circle(ui, dot);
            ui.label(RichText::new(&self.endpoint_label).font(sans(12.5)).strong());
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(RichText::new(status).font(mono(9.0)).color(dot));
            });
        });
        row_card(ui, false, |ui| {
            dot_circle(ui, white_a(70));
            ui.label(RichText::new("Local models").font(sans(12.5)).color(text_dim(200)));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(RichText::new("ON-DEV").font(mono(9.0)).color(text_dim(100)));
            });
        });

        section_label(ui, "SESSIONS");
        row_card(ui, true, |ui| {
            ui.vertical(|ui| {
                ui.label(RichText::new("Voice session").font(sans(12.0)).strong());
                ui.label(
                    RichText::new(format!("live · {}", clock()))
                        .font(mono(9.5))
                        .color(text_dim(110)),
                );
            });
        });

        ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
            let q = row_card(ui, false, |ui| {
                ui.label(RichText::new("⏻").font(sans(13.0)).color(Color32::from_rgb(225, 95, 85)));
                ui.label(RichText::new("Quit ARIA").font(sans(12.5)).color(text_dim(215)));
            });
            if q.interact(egui::Sense::click())
                .on_hover_cursor(egui::CursorIcon::PointingHand)
                .clicked()
            {
                self.really_quit = true;
            }
            let r = row_card(ui, false, |ui| {
                ui.label(RichText::new("⚙").font(sans(13.0)).color(text_dim(150)));
                ui.label(RichText::new("Settings").font(sans(12.5)).color(text_dim(215)));
            });
            if r.interact(egui::Sense::click())
                .on_hover_cursor(egui::CursorIcon::PointingHand)
                .clicked()
            {
                self.settings_open = true;
            }
        });
    }

    // ------------------------------------------------------------- chat --
    fn chat(&mut self, ui: &mut egui::Ui) {
        let accent = state_hue_color(self.state);
        // header
        Frame::new()
            .inner_margin(Margin::symmetric(18, 12))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Voice session").font(sans(13.5)).strong());
                    ui.label(
                        RichText::new(format!(
                            "{} / {}",
                            self.endpoint_label.to_lowercase().replace(' ', "-"),
                            self.settings.model
                        ))
                        .font(mono(9.5))
                        .color(text_dim(115)),
                    );
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        badge(ui, self.state, &self.badge);
                    });
                });
            });
        ui.separator();

        // input bar reserved at the bottom
        let input_h = 64.0;
        let msgs_h = ui.available_height() - input_h;
        egui::ScrollArea::vertical()
            .max_height(msgs_h)
            .auto_shrink(false)
            .stick_to_bottom(true)
            .show(ui, |ui| {
                Frame::new().inner_margin(Margin::symmetric(20, 16)).show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 14.0;
                    if self.msgs.is_empty() {
                        ui.add_space(msgs_h * 0.38);
                        ui.vertical_centered(|ui| {
                            ui.label(
                                RichText::new(format!("Say \"{}\" or type below", self.settings.wake_phrase.replace('_', " ")))
                                    .font(sans(14.0))
                                    .color(text_dim(90)),
                            );
                        });
                    }
                    for m in &self.msgs {
                        bubble(ui, m, accent);
                    }
                });
            });

        // input bar
        Frame::new()
            .fill(white_a(14))
            .stroke(Stroke::new(1.0, white_a(30)))
            .corner_radius(CornerRadius::same(16))
            .inner_margin(Margin::symmetric(12, 9))
            .outer_margin(Margin::same(12))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    let mic_sz = egui::vec2(32.0, 32.0);
                    let send_first = false;
                    let _ = send_first;
                    let edit = egui::TextEdit::singleline(&mut self.input)
                        .hint_text(RichText::new("Message ARIA…").color(text_dim(90)))
                        .frame(Frame::NONE)
                        .desired_width(ui.available_width() - 3.0 * (mic_sz.x + 8.0))
                        .font(sans(13.5));
                    let resp = ui.add(edit);
                    if resp.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                        self.submit_input();
                        resp.request_focus();
                    }
                    // screen share toggle
                    let ss_fill = if self.screen_share {
                        Color32::from_rgb(52, 170, 200)
                    } else {
                        white_a(20)
                    };
                    let ss_fg = if self.screen_share { Some(Color32::from_rgb(6, 19, 28)) } else { None };
                    let ss = button_square(ui, mic_sz, "🖥", ss_fill, ss_fg);
                    if ss.clicked() {
                        let on = !self.screen_share;
                        self.screen_share = on; // optimistic; runtime confirms
                        self.send(UiCommand::ScreenShare(on));
                    }
                    // mic = force-wake
                    let mic = button_square(ui, mic_sz, "🎙", white_a(20), None);
                    if mic.clicked() {
                        self.send(UiCommand::Wake);
                        self.log("wake (mic button)", false);
                    }
                    // send — or stop, while the agent is speaking
                    if self.speaking() && self.input.trim().is_empty() {
                        let stop = button_square(
                            ui,
                            mic_sz,
                            "■",
                            Color32::from_rgb(225, 95, 85),
                            Some(Color32::from_rgb(30, 8, 6)),
                        );
                        if stop.clicked() {
                            self.send(UiCommand::Stop);
                            self.log("interrupted", false);
                        }
                    } else {
                        let send = button_square(
                            ui,
                            mic_sz,
                            "↑",
                            Color32::from_rgb(52, 170, 200),
                            Some(Color32::from_rgb(6, 19, 28)),
                        );
                        if send.clicked() {
                            self.submit_input();
                        }
                    }
                });
            });
    }

    // -------------------------------------------------------------- ops --
    fn ops(&mut self, ui: &mut egui::Ui) {
        ui.set_min_height(ui.available_height());
        ui.vertical_centered(|ui| {
            ui.add_space(16.0);
            let (r, p) = ui.allocate_painter(egui::vec2(250.0, 250.0), egui::Sense::click());
            self.orb.paint_params(
                &p,
                r.rect,
                self.t0.elapsed().as_secs_f32(),
                self.motion_t,
                &self.orb_p,
                self.settings.orb_glow,
            );
            // The orb itself is a big stop button while the agent talks.
            if r.clicked() && self.speaking() {
                self.send(UiCommand::Stop);
                self.log("interrupted (orb)", false);
            }
            if self.speaking() {
                r.on_hover_cursor(egui::CursorIcon::PointingHand)
                    .on_hover_text("click to interrupt");
            }
            ui.add_space(10.0);
            badge(ui, self.state, &self.badge);
        });
        ui.add_space(12.0);

        section_label(ui, "STATE TIMELINE · LAST 60 S");
        self.timeline_bar(ui);
        ui.add_space(10.0);

        {
            section_label(ui, "PERF · LAST TURN · FROM AUDIO_END");
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new("ui ").font(mono(10.0)).color(text_dim(110)));
                ui.label(
                    RichText::new(format!("{:.0}fps  ", self.fps_ema))
                        .font(mono(10.5))
                        .color(text_dim(210)),
                );
                for (stage, ms) in &self.perf {
                    ui.label(RichText::new(format!("{stage} ")).font(mono(10.0)).color(text_dim(110)));
                    ui.label(
                        RichText::new(format!("{ms}ms  "))
                            .font(mono(10.5))
                            .color(text_dim(210)),
                    );
                }
            });
        }

        section_label(ui, "ACTIVITY");
        for (i, (t, line, hl)) in self.activity.iter().enumerate() {
            ui.horizontal(|ui| {
                ui.label(RichText::new(t).font(mono(10.5)).color(text_dim(90)));
                let c = if *hl && i == 0 {
                    state_hue_color(self.state)
                } else {
                    text_dim(165)
                };
                ui.label(RichText::new(line).font(mono(10.5)).color(c));
            });
        }

        ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label(RichText::new("COST").font(mono(9.5)).color(text_dim(100)));
                ui.add_space(8.0);
                ui.label(RichText::new("local session · $0.00").font(mono(10.5)).color(text_dim(190)));
            });
            ui.horizontal(|ui| {
                ui.label(RichText::new("AUDIO").font(mono(9.5)).color(text_dim(100)));
                ui.add_space(4.0);
                let (r, p) = ui.allocate_painter(
                    egui::vec2(ui.available_width() - 60.0, 5.0),
                    egui::Sense::hover(),
                );
                p.rect_filled(r.rect, 3.0, white_a(20));
                let w = r.rect.width() * self.settings.volume.clamp(0.0, 1.0);
                p.rect_filled(
                    egui::Rect::from_min_size(r.rect.min, egui::vec2(w, 5.0)),
                    3.0,
                    Color32::from_rgb(52, 170, 200),
                );
                ui.label(
                    RichText::new(format!("vol {:.0}%", self.settings.volume * 100.0))
                        .font(mono(9.5))
                        .color(text_dim(140)),
                );
            });
            ui.separator();
        });
    }

    fn timeline_bar(&mut self, ui: &mut egui::Ui) {
        let now = Instant::now();
        while self.timeline.len() > 1
            && now.duration_since(self.timeline[1].0).as_secs_f32() > 60.0
        {
            self.timeline.pop_front();
        }
        let (r, p) = ui.allocate_painter(
            egui::vec2(ui.available_width(), 8.0),
            egui::Sense::hover(),
        );
        let rect = r.rect;
        let x_of = |t: Instant| -> f32 {
            let ago = now.duration_since(t).as_secs_f32().min(60.0);
            rect.right() - ago / 60.0 * rect.width()
        };
        p.rect_filled(rect, 4.0, white_a(10));
        for i in 0..self.timeline.len() {
            let (t, s) = self.timeline[i];
            let x0 = x_of(t).max(rect.left());
            let x1 = if i + 1 < self.timeline.len() {
                x_of(self.timeline[i + 1].0)
            } else {
                rect.right()
            };
            if x1 > x0 {
                let mut c = state_hue_color(s);
                c = Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), 190);
                p.rect_filled(
                    egui::Rect::from_min_max(egui::pos2(x0, rect.top()), egui::pos2(x1, rect.bottom())),
                    2.0,
                    c,
                );
            }
        }
        ui.horizontal(|ui| {
            ui.label(RichText::new("-60s").font(mono(8.5)).color(text_dim(90)));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(RichText::new("now").font(mono(8.5)).color(text_dim(90)));
            });
        });
    }

    // --------------------------------------------------------- settings --
    fn settings_modal(&mut self, ctx: &egui::Context) {
        const TABS: &[&str] = &["Harness", "Voice", "Wake & Mic", "Performance", "Updates"];
        let modal = egui::Modal::new(egui::Id::new("settings"))
            .frame(
                Frame::new()
                    .fill(Color32::from_rgb(13, 17, 26))
                    .stroke(Stroke::new(1.0, white_a(36)))
                    .corner_radius(CornerRadius::same(20))
                    .inner_margin(Margin::same(0)),
            )
            .show(ctx, |ui| {
                ui.set_width(740.0);
                ui.horizontal_top(|ui| {
                    // nav rail
                    Frame::new()
                        .fill(white_a(8))
                        .inner_margin(Margin::same(14))
                        .show(ui, |ui| {
                            ui.set_width(160.0);
                            ui.set_min_height(470.0);
                            ui.add_space(4.0);
                            ui.label(RichText::new("Settings").font(sans(16.0)).strong());
                            ui.add_space(14.0);
                            for (i, name) in TABS.iter().enumerate() {
                                let active = self.settings_tab == i;
                                let resp = Frame::new()
                                    .fill(if active { white_a(26) } else { Color32::TRANSPARENT })
                                    .stroke(if active {
                                        Stroke::new(1.0, white_a(30))
                                    } else {
                                        Stroke::NONE
                                    })
                                    .corner_radius(CornerRadius::same(10))
                                    .inner_margin(Margin::symmetric(12, 9))
                                    .show(ui, |ui| {
                                        ui.set_width(ui.available_width());
                                        let c = if active { TEXT } else { text_dim(150) };
                                        ui.label(RichText::new(*name).font(sans(13.0)).color(c));
                                    })
                                    .response
                                    .interact(egui::Sense::click());
                                if resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                                    self.settings_tab = i;
                                }
                                ui.add_space(3.0);
                            }
                            ui.with_layout(Layout::bottom_up(Align::Min), |ui| {
                                ui.label(
                                    RichText::new(format!("ARIA v{}", env!("CARGO_PKG_VERSION")))
                                        .font(mono(9.5))
                                        .color(text_dim(80)),
                                );
                            });
                        });
                    // content
                    Frame::new().inner_margin(Margin::same(18)).show(ui, |ui| {
                        let w = (ui.available_width() - 8.0).max(320.0);
                        ui.set_width(w);
                        egui::ScrollArea::vertical()
                            .max_height(400.0)
                            .auto_shrink(false)
                            .show(ui, |ui| {
                                ui.set_max_width(w);
                                ui.spacing_mut().item_spacing.y = 6.0;
                                match self.settings_tab {
                                    0 => self.tab_harness(ui),
                                    1 => self.tab_voice(ui),
                                    2 => self.tab_wake(ui),
                                    3 => self.tab_perf(ui),
                                    _ => self.tab_updates(ui),
                                }
                            });
                        ui.add_space(10.0);
                        ui.separator();
                        ui.add_space(8.0);
                        ui.horizontal(|ui| {
                            let save = egui::Button::new(
                                RichText::new("Save changes")
                                    .color(Color32::from_rgb(6, 19, 28))
                                    .strong(),
                            )
                            .fill(Color32::from_rgb(52, 170, 200))
                            .corner_radius(CornerRadius::same(9));
                            if ui.add(save).clicked() {
                                let s = self.settings.clone();
                                self.send(UiCommand::SaveSettings(s));
                                self.log("settings saved", false);
                                self.settings_open = false;
                            }
                            if ui.button("Cancel").clicked() {
                                self.settings_open = false;
                            }
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                ui.label(
                                    RichText::new("voice · speed · volume apply live — the rest on restart")
                                        .font(mono(8.5))
                                        .color(text_dim(80)),
                                );
                            });
                        });
                    });
                });
            });
        if modal.should_close() {
            self.settings_open = false;
        }
    }

    fn tab_harness(&mut self, ui: &mut egui::Ui) {
        heading(ui, "Agent harness", "Tools, skills and live data — the default brain.");
        flabel(ui, "ENDPOINT");
        ui.add(egui::TextEdit::singleline(&mut self.settings.endpoint).desired_width(360.0));
        flabel(ui, "MODEL");
        ui.add(egui::TextEdit::singleline(&mut self.settings.model).desired_width(240.0));
        flabel(ui, "API KEY");
        ui.add(
            egui::TextEdit::singleline(&mut self.settings.api_key)
                .password(true)
                .desired_width(360.0),
        );

        ui.add_space(16.0);
        heading(
            ui,
            "Direct LLM · mixture mode",
            "Optional fast chat model with no tools. Auto routing sends tool-shaped queries to the harness and small talk here — both share one conversation.",
        );
        flabel(ui, "ROUTING");
        ui.horizontal(|ui| {
            for mode in ["auto", "harness", "direct"] {
                if ui
                    .selectable_label(self.settings.routing == mode, mode)
                    .clicked()
                {
                    self.settings.routing = mode.into();
                }
            }
        });
        flabel(ui, "DIRECT ENDPOINT (empty = harness only)");
        ui.add(egui::TextEdit::singleline(&mut self.settings.direct_endpoint).desired_width(360.0));
        flabel(ui, "DIRECT MODEL");
        ui.add(egui::TextEdit::singleline(&mut self.settings.direct_model).desired_width(240.0));
        flabel(ui, "DIRECT API KEY");
        ui.add(
            egui::TextEdit::singleline(&mut self.settings.direct_api_key)
                .password(true)
                .desired_width(360.0),
        );
    }

    fn tab_voice(&mut self, ui: &mut egui::Ui) {
        heading(ui, "Voice", "Pick a voice — it switches live and speaks a preview.");
        let mut clicked: Option<String> = None;
        for (v, label) in VOICE_CHOICES {
            let active = self.settings.voice == *v;
            let resp = Frame::new()
                .fill(if active { white_a(22) } else { white_a(8) })
                .stroke(Stroke::new(
                    1.0,
                    if active { Color32::from_rgb(52, 170, 200) } else { white_a(20) },
                ))
                .corner_radius(CornerRadius::same(12))
                .inner_margin(Margin::symmetric(14, 10))
                .show(ui, |ui| {
                    ui.set_width(ui.available_width() - 8.0);
                    ui.horizontal(|ui| {
                        dot_circle(
                            ui,
                            if active {
                                Color32::from_rgb(52, 170, 200)
                            } else {
                                white_a(60)
                            },
                        );
                        ui.label(RichText::new(*label).font(sans(13.0)).color(text_dim(230)));
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            ui.label(
                                RichText::new(if v.contains('-') { "PIPER" } else { "KOKORO" })
                                    .font(mono(8.5))
                                    .color(text_dim(90)),
                            );
                        });
                    });
                })
                .response
                .interact(egui::Sense::click());
            if resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked() {
                clicked = Some(v.to_string());
            }
            ui.add_space(2.0);
        }
        if let Some(v) = clicked {
            self.settings.voice = v.clone();
            self.send(UiCommand::SetVoice(v));
        }

        ui.add_space(14.0);
        heading(ui, "Delivery", "Both apply immediately.");
        flabel(ui, "SPEECH SPEED");
        if ui
            .add(egui::Slider::new(&mut self.settings.tts_speed, 0.5..=2.0).suffix("×"))
            .changed()
        {
            let v = self.settings.tts_speed;
            self.send(UiCommand::SetSpeed(v));
        }
        flabel(ui, "VOLUME");
        if ui
            .add(egui::Slider::new(&mut self.settings.volume, 0.0..=1.0))
            .changed()
        {
            let v = self.settings.volume;
            self.send(UiCommand::SetVolume(v));
        }
    }

    fn tab_wake(&mut self, ui: &mut egui::Ui) {
        heading(
            ui,
            "Wake word",
            "Say the phrase, type it in the chat bar, press the mic button, or hit Alt+Shift+Space.",
        );
        flabel(ui, "PHRASE (openWakeWord model name)");
        ui.add(egui::TextEdit::singleline(&mut self.settings.wake_phrase).desired_width(240.0));
        flabel(ui, "DETECTION THRESHOLD — lower fires easier");
        ui.add(egui::Slider::new(&mut self.settings.wake_threshold, 0.1..=0.9));

        ui.add_space(14.0);
        heading(ui, "Microphone endpointing", "How ARIA decides you started and stopped talking.");
        flabel(ui, "SPEECH ENERGY THRESHOLD — lower hears quieter voices");
        ui.add(egui::Slider::new(&mut self.settings.energy_threshold, 100.0..=2000.0));
        flabel(ui, "END OF UTTERANCE AFTER SILENCE");
        ui.add(egui::Slider::new(&mut self.settings.silence_ms, 300..=1500).suffix(" ms"));

        ui.add_space(14.0);
        heading(ui, "Conversation mode", "After a reply, ARIA keeps listening for a follow-up — no wake word needed.");
        flabel(ui, "FOLLOW-UP WINDOW (0 = off)");
        ui.add(egui::Slider::new(&mut self.settings.followup_ms, 0..=15_000).suffix(" ms"));
    }

    fn tab_perf(&mut self, ui: &mut egui::Ui) {
        heading(ui, "Resource preset", "Auto probes your hardware at startup and tunes model sizes.");
        Frame::new()
            .fill(white_a(10))
            .corner_radius(CornerRadius::same(10))
            .inner_margin(Margin::symmetric(12, 9))
            .show(ui, |ui| {
                ui.label(
                    RichText::new(format!("detected: {}", self.settings.hw_info))
                        .font(mono(10.0))
                        .color(text_dim(170)),
                );
            });
        ui.add_space(4.0);
        flabel(ui, "PRESET");
        ui.horizontal(|ui| {
            for p in ["auto", "eco", "balanced", "performance"] {
                if ui.selectable_label(self.settings.preset == p, p).clicked() {
                    self.settings.preset = p.into();
                }
            }
        });
        flabel(ui, "STT MODEL — auto follows the preset");
        ui.horizontal(|ui| {
            for m in ["auto", "tiny.en", "base.en", "small"] {
                if ui.selectable_label(self.settings.stt_model == m, m).clicked() {
                    self.settings.stt_model = m.into();
                }
            }
        });

        ui.add_space(14.0);
        heading(ui, "Orb", "Visual only — applies live.");
        flabel(ui, "SPIN SPEED");
        ui.add(egui::Slider::new(&mut self.settings.orb_speed, 0.2..=3.0).suffix("×"));
        flabel(ui, "GLOW");
        ui.add(egui::Slider::new(&mut self.settings.orb_glow, 0.2..=2.0).suffix("×"));
    }

    fn tab_updates(&mut self, ui: &mut egui::Ui) {
        heading(ui, "Updates", "Checks GitHub releases and swaps the binary in place.");
        flabel(ui, "RELEASES REPO (owner/repo)");
        ui.add(egui::TextEdit::singleline(&mut self.settings.update_repo).desired_width(280.0));
        ui.add_space(8.0);
        if ui.button("Check for updates").clicked() {
            self.send(UiCommand::CheckUpdate);
        }
        if let Some((_, pct)) = self.perf.iter().find(|(s, _)| s == "update") {
            ui.add_space(6.0);
            ui.add(
                egui::ProgressBar::new(*pct as f32 / 100.0)
                    .desired_width(360.0)
                    .text(format!("downloading {pct}%")),
            );
        }
        ui.add_space(6.0);
        ui.label(
            RichText::new(format!(
                "current version v{} · restart after an update to apply",
                env!("CARGO_PKG_VERSION")
            ))
            .font(mono(9.5))
            .color(text_dim(100)),
        );
    }
}

/// Section header: title + one-line description.
fn heading(ui: &mut egui::Ui, title: &str, desc: &str) {
    ui.label(RichText::new(title).font(sans(14.5)).strong());
    ui.label(RichText::new(desc).font(sans(11.0)).color(text_dim(120)));
    ui.add_space(6.0);
}

/// Small uppercase field label.
fn flabel(ui: &mut egui::Ui, text: &str) {
    ui.add_space(6.0);
    ui.label(RichText::new(text).font(mono(9.0)).color(text_dim(110)));
}

// -------------------------------------------------------------- widgets --

fn section_label(ui: &mut egui::Ui, text: &str) {
    ui.add_space(10.0);
    ui.label(RichText::new(text).font(mono(9.5)).color(text_dim(105)));
    ui.add_space(4.0);
}

fn dot_circle(ui: &mut egui::Ui, color: Color32) {
    let (r, p) = ui.allocate_painter(egui::vec2(8.0, 8.0), egui::Sense::hover());
    p.circle_filled(r.rect.center(), 3.5, color);
}

fn row_card(ui: &mut egui::Ui, active: bool, add: impl FnOnce(&mut egui::Ui)) -> egui::Response {
    let frame = if active {
        Frame::new()
            .fill(white_a(15))
            .stroke(Stroke::new(1.0, white_a(26)))
            .corner_radius(CornerRadius::same(11))
            .inner_margin(Margin::symmetric(10, 8))
    } else {
        Frame::new()
            .corner_radius(CornerRadius::same(11))
            .inner_margin(Margin::symmetric(10, 8))
    };
    let r = frame.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| add(ui));
    });
    r.response
}

fn badge(ui: &mut egui::Ui, state: OrbState, label: &str) {
    let c = state_hue_color(state);
    Frame::new()
        .fill(Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), 26))
        .stroke(Stroke::new(1.0, Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), 90)))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(Margin::symmetric(14, 6))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                dot_circle(ui, c);
                ui.label(RichText::new(label).font(mono(10.0)).color(c));
            });
        });
}

fn bubble(ui: &mut egui::Ui, m: &Msg, accent: Color32) {
    // Manual layout: measure the wrapped text first, then place the bubble
    // left/right with exact size. egui's Align::Max + wrapping mis-measures
    // row heights, which made bubbles overlap.
    let is_user = m.role == Role::User;
    let max_w = if is_user { 440.0f32 } else { 520.0f32 };
    let (fill, stroke, radius) = match m.role {
        Role::User => (
            white_a(30),
            Stroke::new(1.0, white_a(46)),
            CornerRadius { nw: 16, ne: 16, sw: 16, se: 5 },
        ),
        Role::Assistant if !m.done => (
            white_a(12),
            Stroke::new(
                1.0,
                Color32::from_rgba_unmultiplied(accent.r(), accent.g(), accent.b(), 80),
            ),
            CornerRadius::same(16),
        ),
        Role::Assistant => (
            white_a(12),
            Stroke::new(1.0, white_a(28)),
            CornerRadius { nw: 5, ne: 16, sw: 16, se: 16 },
        ),
        Role::Tool => (
            Color32::from_rgba_unmultiplied(0, 0, 0, 90),
            Stroke::new(1.0, white_a(24)),
            CornerRadius::same(13),
        ),
    };
    let font = if m.role == Role::Tool { mono(11.0) } else { sans(13.5) };
    let mut text = m.text.clone();
    if !m.done {
        text.push_str(" ▍");
    }
    let pad = egui::vec2(15.0, 11.0);
    let wrap_w = (max_w - pad.x * 2.0).min(ui.available_width() - pad.x * 2.0 - 8.0);
    let galley = ui.painter().layout(text, font, text_dim(235), wrap_w.max(60.0));
    let bubble_size = galley.size() + pad * 2.0;
    const TS_H: f32 = 13.0;
    let (rect, _) = ui.allocate_exact_size(
        egui::vec2(ui.available_width(), bubble_size.y + TS_H + 3.0),
        egui::Sense::hover(),
    );
    if !ui.is_rect_visible(rect) {
        return; // scrolled out — skip painting
    }
    let x0 = if is_user { rect.right() - bubble_size.x } else { rect.left() };
    let brect = egui::Rect::from_min_size(egui::pos2(x0, rect.top()), bubble_size);
    let p = ui.painter();
    p.rect(brect, radius, fill, stroke, egui::StrokeKind::Inside);
    p.galley(brect.min + pad, galley, text_dim(235));
    let (ts_x, ts_align) = if is_user {
        (brect.right(), egui::Align2::RIGHT_TOP)
    } else {
        (brect.left(), egui::Align2::LEFT_TOP)
    };
    p.text(
        egui::pos2(ts_x, brect.bottom() + 3.0),
        ts_align,
        &m.at,
        mono(8.5),
        text_dim(70),
    );
}

fn button_square(
    ui: &mut egui::Ui,
    size: egui::Vec2,
    glyph: &str,
    fill: Color32,
    fg: Option<Color32>,
) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(size, egui::Sense::click());
    let resp = resp.on_hover_cursor(egui::CursorIcon::PointingHand);
    let p = ui.painter();
    p.rect_filled(rect, 11.0, fill);
    p.rect_stroke(rect, 11.0, Stroke::new(1.0, white_a(30)), egui::StrokeKind::Inside);
    p.text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        glyph,
        sans(14.0),
        fg.unwrap_or(TEXT),
    );
    resp
}
