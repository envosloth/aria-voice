//! Screen share: one frame per query via the xdg-desktop-portal Screenshot
//! API (the only compositor-blessed path on Wayland), downscaled to ~768 px
//! and JPEG-compressed before hitting the vision model (A-19 — glance-sized
//! frames keep screen-share responses fast).

use base64::Engine as _;
use std::collections::HashMap;
use std::time::Duration;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedValue, Value};

const GLANCE_WIDTH: u32 = 768;

/// Capture the screen and return an OpenAI-style `data:image/jpeg;base64,…` URL.
pub fn capture_data_url() -> Result<String, String> {
    let uri = portal_screenshot()?;
    let path = uri
        .strip_prefix("file://")
        .ok_or_else(|| format!("unexpected screenshot uri: {uri}"))?;
    let img = image::open(path).map_err(|e| format!("decode: {e}"))?;
    let _ = std::fs::remove_file(path); // portal drops it in ~/Pictures otherwise
    let img = if img.width() > GLANCE_WIDTH {
        img.resize(GLANCE_WIDTH, u32::MAX, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut jpeg = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 70);
    enc.encode_image(&img.to_rgb8()).map_err(|e| format!("encode: {e}"))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&jpeg)
    ))
}

/// org.freedesktop.portal.Screenshot round-trip: call, then wait for the
/// Response signal on the returned request handle.
fn portal_screenshot() -> Result<String, String> {
    let conn = Connection::session().map_err(|e| format!("dbus: {e}"))?;
    let proxy = Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Screenshot",
    )
    .map_err(|e| format!("portal: {e}"))?;

    let token = format!("aria{}", std::process::id());
    let mut opts: HashMap<&str, Value> = HashMap::new();
    opts.insert("handle_token", Value::from(token.clone()));
    opts.insert("interactive", Value::from(false));

    let request_path: zbus::zvariant::OwnedObjectPath = proxy
        .call("Screenshot", &("", opts))
        .map_err(|e| format!("screenshot call: {e}"))?;

    let req = Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        request_path.as_str(),
        "org.freedesktop.portal.Request",
    )
    .map_err(|e| format!("request: {e}"))?;

    let mut signals = req.receive_signal("Response").map_err(|e| format!("signal: {e}"))?;
    // The user may need to approve a dialog the first time — give them time.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        if let Some(msg) = signals.next() {
            let (code, results): (u32, HashMap<String, OwnedValue>) =
                msg.body().deserialize().map_err(|e| format!("response: {e}"))?;
            if code != 0 {
                return Err("screenshot cancelled by user/compositor".into());
            }
            let uri = results
                .get("uri")
                .and_then(|v| v.downcast_ref::<String>().ok())
                .ok_or("no uri in response")?;
            return Ok(uri);
        }
    }
    Err("screenshot timed out".into())
}
