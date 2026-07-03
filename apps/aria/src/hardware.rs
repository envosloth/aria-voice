//! Hardware probe → resource preset (A-12). Detects cores/RAM/GPU at startup
//! and picks STT model size + threads for responsive latency on any box;
//! explicit `stt.model`/`stt.threads`/`perf.preset` config always wins.

use aria_core::Config;

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub preset: &'static str,
    pub stt_model: String,
    pub stt_threads: usize,
    pub gpu: bool,
}

fn total_ram_gb() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|kb| kb.parse::<u64>().ok())
        })
        .map(|kb| kb / 1024 / 1024)
        .unwrap_or(8)
}

fn has_gpu() -> bool {
    // A render node + a Vulkan ICD is what whisper's Vulkan backend needs.
    let render_node = std::fs::read_dir("/dev/dri")
        .map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().starts_with("renderD")))
        .unwrap_or(false);
    let icd = std::path::Path::new("/usr/share/vulkan/icd.d").exists();
    render_node && icd
}

pub fn resolve(cfg: &Config) -> Resolved {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let ram_gb = total_ram_gb();
    let gpu = has_gpu();

    let preset = match cfg.perf.preset.as_str() {
        p @ ("eco" | "balanced" | "performance") => match p {
            "eco" => "eco",
            "balanced" => "balanced",
            _ => "performance",
        },
        _ => {
            // auto
            if (gpu && ram_gb >= 12) || (cores >= 12 && ram_gb >= 16) {
                "performance"
            } else if cores >= 6 && ram_gb >= 8 {
                "balanced"
            } else {
                "eco"
            }
        }
    };

    // GPU decodes base.en faster than CPU decodes tiny.en — accuracy is free
    // there. CPU-only boxes trade down to stay responsive.
    let stt_model = if cfg.stt.model != "auto" {
        cfg.stt.model.clone()
    } else {
        match (preset, gpu) {
            ("performance", true) => "base.en",
            ("performance", false) => "base.en",
            ("balanced", true) => "base.en",
            ("balanced", false) => "tiny.en",
            _ => "tiny.en",
        }
        .to_string()
    };

    let stt_threads = if cfg.stt.threads != 0 {
        cfg.stt.threads
    } else {
        match preset {
            "performance" => (cores / 2).clamp(4, 8),
            "balanced" => 4.min(cores),
            _ => 2,
        }
    };

    Resolved { preset, stt_model, stt_threads, gpu }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_config_overrides_preset() {
        let mut cfg = Config::default();
        cfg.stt.model = "small".into();
        cfg.stt.threads = 3;
        let r = resolve(&cfg);
        assert_eq!(r.stt_model, "small");
        assert_eq!(r.stt_threads, 3);
    }

    #[test]
    fn auto_resolves_to_a_valid_preset_and_model() {
        let r = resolve(&Config::default());
        assert!(["eco", "balanced", "performance"].contains(&r.preset));
        assert!(["tiny.en", "base.en"].contains(&r.stt_model.as_str()));
        assert!(r.stt_threads >= 1);
    }
}
