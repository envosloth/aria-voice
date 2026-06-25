// AudioWorklet processor for mic capture. Runs on the audio render thread,
// accumulates the 128-sample quantums into ~20ms chunks, and posts Float32
// frames (mono) to the main renderer thread, which downsamples to 16kHz and
// forwards to the wake-word / STT sidecars.
//
// Loaded via audioContext.audioWorklet.addModule('mic-worklet.js').

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ~20ms at the context rate (e.g. 960 samples @ 48kHz). Buffer up to that
    // before posting, to avoid flooding the message port with 128-sample frames.
    this._chunkSize = Math.round(sampleRate * 0.02);
    this._buf = new Float32Array(this._chunkSize);
    this._pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0]; // mono (first channel)
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buf[this._pos++] = channel[i];
      if (this._pos >= this._chunkSize) {
        // Transfer a copy so the buffer can be reused immediately.
        const out = this._buf.slice(0, this._pos);
        this.port.postMessage({ samples: out, rate: sampleRate }, [out.buffer]);
        this._pos = 0;
      }
    }
    return true; // keep processor alive
  }
}

registerProcessor('mic-capture', MicCaptureProcessor);
