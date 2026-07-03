//! Versioned, schema-validated TOML config (spec §7). Zero-config must work.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("cannot read config: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid TOML: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("unsupported schema_version {0} (this build supports <= {SCHEMA_VERSION})")]
    FutureVersion(u32),
    #[error("invalid config: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub schema_version: u32,
    pub audio: AudioCfg,
    pub models: ModelsCfg,
    pub wake: WakeCfg,
    pub endpoint: EndpointCfg,
    pub stt: SttCfg,
    pub perf: PerfCfg,
    pub llm: LlmCfg,
    pub tts: TtsCfg,
    pub orb: OrbCfg,
    pub health: HealthCfg,
    pub update: UpdateCfg,
}

/// In-app updater source.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct UpdateCfg {
    /// GitHub "owner/repo" that publishes release binaries.
    pub repo: String,
}

impl Default for UpdateCfg {
    fn default() -> Self {
        Self { repo: "envosloth/aria-voice".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct AudioCfg {
    /// SPSC capture ring size in 16 kHz samples (§6.1: configured, not hardcoded).
    pub capture_ring_samples: usize,
    /// Bounded playback queue length in chunks (§2.6: bounded everything).
    pub playback_queue_max: usize,
    pub master_volume: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ModelsCfg {
    /// Cache dir for all models (§6.8); `~` expands at load.
    pub dir: String,
}

/// Energy endpointing (§4.3) — VAD stays out of this path (A-3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct EndpointCfg {
    /// RMS (i16 scale) above which a frame counts as speech.
    pub energy_threshold: f32,
    /// Utterance ends after this much sub-threshold audio.
    pub silence_ms: u64,
    /// Give up waiting for speech to start after this long.
    pub speech_start_timeout_ms: u64,
    pub max_utterance_ms: u64,
    /// Conversation mode: after a reply, keep listening this long for a
    /// follow-up (no wake word needed). 0 disables.
    pub followup_window_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct WakeCfg {
    pub phrase: String,
    pub threshold: f32,
    /// A-3: VAD gating silently broke wake detection in v2 — default OFF.
    pub vad_enabled: bool,
    pub cooldown_ms: u64,
    /// A-7: `jarvis` should trigger `hey_jarvis`.
    pub sub_phrase_match: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct SttCfg {
    /// "auto" | "vulkan" | "metal" | "cuda" | "cpu"
    pub backend: String,
    /// 0 = derive from hardware probe (A-12).
    pub threads: usize,
    pub gpu_cap: f32,
    /// "auto" (resolved by the perf preset) or an explicit ggml model stem,
    /// e.g. "tiny.en" / "base.en" / "small".
    pub model: String,
}

/// Resource preset (auto-tuned from detected hardware, user-overridable).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct PerfCfg {
    /// "auto" | "eco" | "balanced" | "performance"
    pub preset: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct LlmCfg {
    /// A-9: endpoint/port/key are config, never hardcoded in module code.
    /// This is the agent-harness gateway (tools + skills).
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub keep_alive: bool,
    pub tcp_nodelay: bool,
    /// Mixture mode: "auto" routes per query, "harness"/"direct" force a path.
    /// Auto falls back to harness while no direct endpoint is configured.
    pub routing: String,
    /// Optional direct LLM (fast tool-less chat, cloud or local).
    pub direct_endpoint: String,
    pub direct_api_key: String,
    pub direct_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct TtsCfg {
    pub voice: String,
    /// Piper length_scale-driven live speed (§6.5).
    pub speed: f32,
    pub volume: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct OrbCfg {
    /// A-1: uncapped render loops were v2's CPU/crash root cause.
    pub fps_cap: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct HealthCfg {
    pub memory_ceiling_mb: u64,
    pub breaker_failure_threshold: u32,
    /// A-11: breakers must auto-reset.
    pub breaker_cooldown_s: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            audio: AudioCfg::default(),
            models: ModelsCfg::default(),
            wake: WakeCfg::default(),
            endpoint: EndpointCfg::default(),
            stt: SttCfg::default(),
            perf: PerfCfg::default(),
            llm: LlmCfg::default(),
            tts: TtsCfg::default(),
            orb: OrbCfg::default(),
            health: HealthCfg::default(),
            update: UpdateCfg::default(),
        }
    }
}

impl Default for AudioCfg {
    fn default() -> Self {
        Self {
            capture_ring_samples: 16_000 * 30, // 30 s at 16 kHz
            playback_queue_max: 64,
            master_volume: 1.0,
        }
    }
}

impl Default for ModelsCfg {
    fn default() -> Self {
        Self { dir: "~/.local/share/aria/models".into() }
    }
}

impl ModelsCfg {
    /// `dir` with a leading `~` expanded.
    pub fn expanded_dir(&self) -> std::path::PathBuf {
        match (self.dir.strip_prefix("~/"), std::env::var("HOME")) {
            (Some(rest), Ok(home)) => std::path::Path::new(&home).join(rest),
            _ => std::path::PathBuf::from(&self.dir),
        }
    }
}

impl Default for EndpointCfg {
    fn default() -> Self {
        Self {
            energy_threshold: 500.0,
            silence_ms: 700,
            speech_start_timeout_ms: 5000,
            max_utterance_ms: 10_000,
            followup_window_ms: 6000,
        }
    }
}

impl Default for WakeCfg {
    fn default() -> Self {
        Self {
            phrase: "hey_jarvis".into(),
            threshold: 0.35,
            vad_enabled: false,
            cooldown_ms: 1500,
            sub_phrase_match: true,
        }
    }
}

impl Default for SttCfg {
    fn default() -> Self {
        Self {
            backend: "auto".into(),
            threads: 0,
            gpu_cap: 1.0,
            model: "auto".into(),
        }
    }
}

impl Default for PerfCfg {
    fn default() -> Self {
        Self { preset: "auto".into() }
    }
}

impl Default for LlmCfg {
    fn default() -> Self {
        Self {
            // Default only — user-overridable; v2's real gateway lesson (A-9).
            endpoint: "http://127.0.0.1:8642".into(),
            api_key: String::new(),
            model: "local".into(),
            keep_alive: true,
            tcp_nodelay: true,
            routing: "auto".into(),
            direct_endpoint: String::new(),
            direct_api_key: String::new(),
            direct_model: String::new(),
        }
    }
}

impl Default for TtsCfg {
    fn default() -> Self {
        Self {
            voice: "bm_george".into(), // Kokoro British male — the Jarvis default
            speed: 1.0,
            volume: 1.0,
        }
    }
}

impl Default for OrbCfg {
    fn default() -> Self {
        Self { fps_cap: 60 }
    }
}

impl Default for HealthCfg {
    fn default() -> Self {
        Self {
            memory_ceiling_mb: 2048,
            breaker_failure_threshold: 3,
            breaker_cooldown_s: 30,
        }
    }
}

impl Config {
    pub fn from_toml(s: &str) -> Result<Self, ConfigError> {
        let cfg: Config = toml::from_str(s)?;
        cfg.migrate()?.validate()
    }

    pub fn load(path: &std::path::Path) -> Result<Self, ConfigError> {
        Self::from_toml(&std::fs::read_to_string(path)?)
    }

    /// Forward migration on load (§7). ponytail: v1 is the only schema; the
    /// match arm structure is the migration seam for v2+.
    fn migrate(self) -> Result<Self, ConfigError> {
        match self.schema_version {
            SCHEMA_VERSION => Ok(self),
            v if v > SCHEMA_VERSION => Err(ConfigError::FutureVersion(v)),
            _ => Err(ConfigError::Invalid(format!(
                "schema_version {} predates first release",
                self.schema_version
            ))),
        }
    }

    fn validate(self) -> Result<Self, ConfigError> {
        fn check(ok: bool, msg: &str) -> Result<(), ConfigError> {
            ok.then_some(()).ok_or_else(|| ConfigError::Invalid(msg.into()))
        }
        check(
            self.wake.threshold > 0.0 && self.wake.threshold <= 1.0,
            "wake.threshold must be in (0, 1]",
        )?;
        check(self.tts.speed > 0.0, "tts.speed must be > 0")?;
        check(
            (0.0..=1.0).contains(&self.tts.volume),
            "tts.volume must be in [0, 1]",
        )?;
        check(
            (0.0..=1.0).contains(&self.audio.master_volume),
            "audio.master_volume must be in [0, 1]",
        )?;
        check(self.orb.fps_cap > 0, "orb.fps_cap must be > 0")?;
        check(
            self.audio.capture_ring_samples > 0 && self.audio.playback_queue_max > 0,
            "audio buffer sizes must be > 0",
        )?;
        check(!self.llm.endpoint.is_empty(), "llm.endpoint must be set")?;
        check(
            ["auto", "direct", "harness"].contains(&self.llm.routing.as_str()),
            "llm.routing must be auto|direct|harness",
        )?;
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_config_defaults_are_valid() {
        let cfg = Config::from_toml("").unwrap();
        assert_eq!(cfg, Config::default());
        assert!(!cfg.wake.vad_enabled); // A-3
    }

    #[test]
    fn partial_toml_overrides_defaults() {
        let cfg = Config::from_toml("[wake]\nthreshold = 0.6\n").unwrap();
        assert_eq!(cfg.wake.threshold, 0.6);
        assert_eq!(cfg.tts.speed, 1.0);
    }

    #[test]
    fn rejects_bad_values_and_unknown_fields() {
        assert!(Config::from_toml("[wake]\nthreshold = 2.0\n").is_err());
        assert!(Config::from_toml("[wake]\nthresold = 0.4\n").is_err()); // typo
        assert!(Config::from_toml("schema_version = 99\n").is_err());
    }

    #[test]
    fn default_roundtrips_through_toml() {
        let s = toml::to_string(&Config::default()).unwrap();
        assert_eq!(Config::from_toml(&s).unwrap(), Config::default());
    }
}
