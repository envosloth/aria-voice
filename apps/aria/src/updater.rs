//! In-app updater: check GitHub releases, stream the download with real
//! progress events (resumable-checksummed downloads land with aria-models,
//! A-10 — this is the app-binary channel), swap ~/.local/bin/aria atomically.

use std::io::Read;
use std::sync::mpsc::Sender;

use aria_ui::UiEvent;

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn check_and_update(repo: &str, events: Sender<UiEvent>) {
    let send = |e: UiEvent| {
        let _ = events.send(e);
    };
    let api = format!("https://api.github.com/repos/{repo}/releases/latest");
    let agent = ureq::Agent::new_with_defaults();
    let resp = agent
        .get(&api)
        .header("User-Agent", "aria-updater")
        .call();
    let body: serde_json::Value = match resp.and_then(|r| r.into_body().read_json()) {
        Ok(v) => v,
        Err(e) => return send(UiEvent::Activity(format!("update check failed: {e}"))),
    };
    let tag = body["tag_name"].as_str().unwrap_or_default();
    let latest = tag.trim_start_matches('v');
    if latest.is_empty() {
        return send(UiEvent::Activity("update check: no releases found".into()));
    }
    if latest == CURRENT_VERSION {
        return send(UiEvent::Activity(format!("up to date (v{CURRENT_VERSION})")));
    }
    // Linux binary asset: prefer exact "aria", else anything linux-ish.
    let assets = body["assets"].as_array().cloned().unwrap_or_default();
    let asset = assets
        .iter()
        .find(|a| a["name"].as_str() == Some("aria"))
        .or_else(|| {
            assets.iter().find(|a| {
                a["name"]
                    .as_str()
                    .is_some_and(|n| n.contains("linux") && !n.ends_with(".deb"))
            })
        });
    let Some(asset) = asset else {
        return send(UiEvent::Activity(format!("v{latest} has no linux binary asset")));
    };
    let url = asset["browser_download_url"].as_str().unwrap_or_default();
    let total = asset["size"].as_u64().unwrap_or(0);
    send(UiEvent::Activity(format!("downloading v{latest}…")));

    let resp = match agent.get(url).header("User-Agent", "aria-updater").call() {
        Ok(r) => r,
        Err(e) => return send(UiEvent::Activity(format!("download failed: {e}"))),
    };
    let home = std::env::var("HOME").unwrap_or_default();
    let target = std::path::Path::new(&home).join(".local/bin/aria");
    let tmp = target.with_extension("new");
    let Ok(mut out) = std::fs::File::create(&tmp) else {
        return send(UiEvent::Activity("cannot write update file".into()));
    };
    let mut reader = resp.into_body().into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_pct = 0u128;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                use std::io::Write;
                if out.write_all(&buf[..n]).is_err() {
                    return send(UiEvent::Activity("update write failed".into()));
                }
                done += n as u64;
                if total > 0 {
                    let pct = (done * 100 / total) as u128;
                    if pct != last_pct {
                        last_pct = pct;
                        send(UiEvent::Perf("update".into(), pct)); // progress bar feed
                    }
                }
            }
            Err(e) => return send(UiEvent::Activity(format!("download error: {e}"))),
        }
    }
    drop(out);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    // Atomic swap: the running process keeps its old inode; next launch is new.
    match std::fs::rename(&tmp, &target) {
        Ok(()) => send(UiEvent::Activity(format!(
            "updated to v{latest} — restart ARIA to apply"
        ))),
        Err(e) => send(UiEvent::Activity(format!("update install failed: {e}"))),
    }
}
