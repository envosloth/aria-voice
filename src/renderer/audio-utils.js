// Audio format helpers for the mic capture path. Pure functions so they can be
// unit-tested in Node and loaded directly in the renderer (no bundler).
//
// The mic delivers Float32 samples at the AudioContext rate (commonly 48000 Hz).
// The STT/wake-word sidecars expect 16000 Hz mono signed-16-bit PCM. These
// helpers downsample (linear interpolation — adequate for speech) and convert.

(function (root) {
  const TARGET_RATE = 16000;

  // Downsample a Float32 mono buffer from sourceRate to 16000 Hz via linear
  // interpolation. Returns a Float32Array at the target rate.
  function downsampleTo16k(float32, sourceRate) {
    if (sourceRate === TARGET_RATE) return float32;
    if (sourceRate < TARGET_RATE) {
      throw new Error(`source rate ${sourceRate} below target ${TARGET_RATE}`);
    }
    const ratio = sourceRate / TARGET_RATE;
    const outLength = Math.floor(float32.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcPos = i * ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, float32.length - 1);
      const frac = srcPos - i0;
      out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
    }
    return out;
  }

  // Convert a Float32 buffer in [-1, 1] to signed 16-bit PCM (little-endian),
  // returned as an ArrayBuffer ready to ship over IPC.
  function floatToInt16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      let s = float32[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  // Full pipeline: Float32 @ sourceRate -> Int16 PCM ArrayBuffer @ 16kHz.
  function micFrameToPcm16k(float32, sourceRate) {
    return floatToInt16(downsampleTo16k(float32, sourceRate));
  }

  // Root-mean-square energy of a Float32 frame (0..~1).
  function rms(float32) {
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    return Math.sqrt(sum / float32.length);
  }

  // Energy-based endpointer for hands-free turns. Feed it per-frame RMS (or
  // raw frames); it reports when an utterance has ended — i.e. speech was seen
  // and then `hangMs` of sustained silence followed. Decoupled from timers so
  // it can be unit-tested deterministically.
  function VadEndpointer(opts) {
    opts = opts || {};
    const threshold = opts.threshold != null ? opts.threshold : 0.012;
    const hangMs = opts.hangMs != null ? opts.hangMs : 800;
    const frameMs = opts.frameMs != null ? opts.frameMs : 20;
    let sawSpeech = false;
    let silenceMs = 0;
    let ended = false;

    // Returns true exactly once, on the frame that ends the utterance.
    this.pushRms = function (frameRms) {
      if (ended) return false;
      if (frameRms >= threshold) {
        sawSpeech = true;
        silenceMs = 0;
      } else if (sawSpeech) {
        silenceMs += frameMs;
        if (silenceMs >= hangMs) {
          ended = true;
          return true;
        }
      }
      return false;
    };
    this.pushFrame = function (float32) { return this.pushRms(rms(float32)); };
    this.reset = function () { sawSpeech = false; silenceMs = 0; ended = false; };
    this.hasSpeech = function () { return sawSpeech; };
  }

  const api = {
    TARGET_RATE, downsampleTo16k, floatToInt16, micFrameToPcm16k, rms, VadEndpointer,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node (tests)
  } else {
    root.AriaAudio = api; // browser (renderer)
  }
})(typeof self !== 'undefined' ? self : this);
