//! Audio I/O (spec §6.1). The cpal callback is the RT thread (§5.1): it only
//! moves samples across lock-free SPSC rings — no locks, no allocation, no
//! logging. Resampling happens on a pump thread, never in the callback (A-2).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use aria_core::{AudioSink, AudioSource};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use rubato::{FastFixedIn, PolynomialDegree, Resampler};

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("no default audio device")]
    NoDevice,
    #[error("audio: {0}")]
    Backend(String),
}

// ---------------------------------------------------------------- capture --

/// Owns the cpal input stream and the resample pump. Not Send (cpal streams
/// aren't); keep it on the thread that created it. The paired `CaptureSource`
/// is Send and feeds wake/STT.
pub struct Capture {
    _stream: cpal::Stream,
    stop: Arc<AtomicBool>,
    pump: Option<std::thread::JoinHandle<()>>,
}

pub struct CaptureSource {
    rx: HeapCons<i16>,
}

impl Capture {
    /// Capture at device-native rate, resample to 16 kHz mono i16.
    /// `ring_samples` bounds both rings (§2.6).
    pub fn start(ring_samples: usize) -> Result<(Self, CaptureSource), AudioError> {
        let device = cpal::default_host()
            .default_input_device()
            .ok_or(AudioError::NoDevice)?;
        let cfg = device
            .default_input_config()
            .map_err(|e| AudioError::Backend(e.to_string()))?;
        let in_rate = cfg.sample_rate().0;
        let channels = cfg.channels() as usize;

        // RT ring: interleaved f32 at native rate. Pump ring: 16 kHz mono i16.
        let (mut rt_tx, mut rt_rx) = HeapRb::<f32>::new(ring_samples.max(in_rate as usize)).split();
        let (mut out_tx, out_rx) = HeapRb::<i16>::new(ring_samples).split();

        let stream = device
            .build_input_stream(
                &cfg.into(),
                move |data: &[f32], _| {
                    // RT hot path: push only; overrun drops oldest-first is
                    // not possible on SPSC, so excess samples are dropped.
                    rt_tx.push_slice(data);
                },
                |e| eprintln!("capture stream error: {e}"),
                None,
            )
            .map_err(|e| AudioError::Backend(e.to_string()))?;
        stream.play().map_err(|e| AudioError::Backend(e.to_string()))?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let pump = std::thread::Builder::new()
            .name("audio-capture-pump".into())
            .spawn(move || {
                const CHUNK: usize = 1024; // native frames per resample call
                let ratio = 16_000.0 / in_rate as f64;
                let mut rs = FastFixedIn::<f32>::new(ratio, 1.0, PolynomialDegree::Linear, CHUNK, 1)
                    .expect("resampler");
                let mut interleaved = vec![0f32; CHUNK * channels];
                let mut mono = vec![0f32; CHUNK];
                while !stop2.load(Ordering::Relaxed) {
                    let want = CHUNK * channels;
                    if rt_rx.occupied_len() < want {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                    rt_rx.pop_slice(&mut interleaved[..want]);
                    for (i, frame) in interleaved[..want].chunks(channels).enumerate() {
                        mono[i] = frame.iter().sum::<f32>() / channels as f32;
                    }
                    if let Ok(out) = rs.process(&[&mono], None) {
                        for &s in &out[0] {
                            let _ = out_tx.try_push((s.clamp(-1.0, 1.0) * 32767.0) as i16);
                        }
                    }
                }
            })
            .map_err(|e| AudioError::Backend(e.to_string()))?;

        Ok((
            Self { _stream: stream, stop, pump: Some(pump) },
            CaptureSource { rx: out_rx },
        ))
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.pump.take() {
            let _ = h.join(); // clean shutdown, no orphaned threads (§5.3)
        }
    }
}

impl AudioSource for CaptureSource {
    fn read(&mut self, buf: &mut [i16]) -> usize {
        self.rx.pop_slice(buf)
    }
}

// --------------------------------------------------------------- playback --

/// Owns the cpal output stream. The paired `PlaybackSink` is Send.
pub struct Playback {
    _stream: cpal::Stream,
}

pub struct PlaybackSink {
    tx: HeapProd<f32>,
    device_rate: u32,
    /// f32 gain stored as bits — lock-free live volume (§6.1).
    volume: Arc<AtomicU32>,
    /// Barge-in: callback drains the ring when set (A-7).
    flush: Arc<AtomicBool>,
    ring_cap: usize,
}

impl Playback {
    pub fn start(ring_samples: usize, volume: f32) -> Result<(Self, PlaybackSink), AudioError> {
        let device = cpal::default_host()
            .default_output_device()
            .ok_or(AudioError::NoDevice)?;
        let cfg = device
            .default_output_config()
            .map_err(|e| AudioError::Backend(e.to_string()))?;
        let device_rate = cfg.sample_rate().0;
        let channels = cfg.channels() as usize;

        let (tx, mut rx) = HeapRb::<f32>::new(ring_samples).split();
        let vol = Arc::new(AtomicU32::new(volume.to_bits()));
        let flush = Arc::new(AtomicBool::new(false));
        let (vol2, flush2) = (vol.clone(), flush.clone());

        let stream = device
            .build_output_stream(
                &cfg.into(),
                move |out: &mut [f32], _| {
                    if flush2.swap(false, Ordering::Relaxed) {
                        rx.clear();
                    }
                    let gain = f32::from_bits(vol2.load(Ordering::Relaxed));
                    for frame in out.chunks_mut(channels) {
                        let s = rx.try_pop().unwrap_or(0.0) * gain;
                        frame.fill(s); // mono → all channels
                    }
                },
                |e| eprintln!("playback stream error: {e}"),
                None,
            )
            .map_err(|e| AudioError::Backend(e.to_string()))?;
        stream.play().map_err(|e| AudioError::Backend(e.to_string()))?;

        Ok((
            Self { _stream: stream },
            PlaybackSink { tx, device_rate, volume: vol, flush, ring_cap: ring_samples },
        ))
    }
}

impl PlaybackSink {
    /// Enqueue PCM recorded at `in_rate`; resamples to the device rate.
    /// Blocks (bounded queue backpressure, A-8) — call from a worker thread.
    pub fn play(&mut self, pcm: &[i16], in_rate: u32) {
        let samples: Vec<f32> = pcm.iter().map(|&s| s as f32 / 32768.0).collect();
        let out = if in_rate == self.device_rate {
            samples
        } else {
            resample_all(&samples, in_rate, self.device_rate)
        };
        for &s in &out {
            while self.tx.try_push(s).is_err() {
                if self.flush.load(Ordering::Relaxed) {
                    return; // barge-in while blocked: drop the rest
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }

    /// A-7: atomically discard everything queued (callback drains on next tick).
    pub fn stop_now(&mut self) {
        self.flush.store(true, Ordering::Relaxed);
    }

    pub fn set_volume(&self, v: f32) {
        self.volume.store(v.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    /// Samples still queued (approximate) — used to wait out the tail.
    pub fn queued(&self) -> usize {
        self.ring_cap - self.tx.vacant_len()
    }

    pub fn device_rate(&self) -> u32 {
        self.device_rate
    }
}

impl AudioSink for PlaybackSink {
    fn write(&mut self, pcm: &[i16]) {
        // Trait contract: TTS-rate PCM lands here; PiperTts runs at 22.05 kHz.
        self.play(pcm, 22_050);
    }
}

/// Whole-buffer resample, non-RT path (TTS output → device rate).
pub fn resample_all(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = to as f64 / from as f64;
    let mut rs = FastFixedIn::<f32>::new(ratio, 1.0, PolynomialDegree::Cubic, samples.len(), 1)
        .expect("resampler");
    match rs.process(&[samples], None) {
        Ok(mut out) => std::mem::take(&mut out[0]),
        Err(_) => samples.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_preserves_duration_and_tone() {
        // 100 ms of 440 Hz at 48 kHz → 16 kHz
        let src: Vec<f32> = (0..4800)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48_000.0).sin())
            .collect();
        let out = resample_all(&src, 48_000, 16_000);
        let expect = 1600.0;
        assert!((out.len() as f32 - expect).abs() / expect < 0.05, "len {}", out.len());
        // zero-crossing count ≈ same tone: 440 Hz * 0.1 s * 2 ≈ 88
        let zc = out.windows(2).filter(|w| (w[0] >= 0.0) != (w[1] >= 0.0)).count();
        assert!((70..110).contains(&zc), "zero crossings {zc}");
    }

    #[test]
    fn live_devices_if_present() {
        // CI/headless boxes may have no devices — that must be a clean error,
        // not a panic (§5.3 degraded boot).
        match Playback::start(48_000, 0.5) {
            Ok((_p, mut sink)) => {
                sink.set_volume(0.2);
                sink.play(&vec![0i16; 2205], 22_050); // 100 ms silence
                sink.stop_now();
            }
            Err(e) => println!("skipping playback: {e}"),
        }
        match Capture::start(16_000 * 30) {
            Ok((_c, mut src)) => {
                let mut buf = [0i16; 1280];
                let _ = src.read(&mut buf);
            }
            Err(e) => println!("skipping capture: {e}"),
        }
    }
}
