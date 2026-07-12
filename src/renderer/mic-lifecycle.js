// Single-flight lifecycle for getUserMedia + AudioWorklet setup. Kept DOM-free
// so the failure/retry path is deterministic in the renderer smoke test.
(function (root) {
  class MicStartupGate {
    constructor() {
      this._cleanup = null;
      this._starting = null;
    }

    started() { return !!this._cleanup; }

    start(create) {
      if (this._cleanup) return Promise.resolve();
      if (this._starting) return this._starting;
      this._starting = (async () => {
        let cleanup = null;
        try {
          cleanup = await create();
          if (typeof cleanup !== 'function') throw new Error('mic startup did not return cleanup');
          this._cleanup = cleanup;
        } catch (error) {
          // If setup got far enough to allocate a stream/context before a later
          // worklet step failed, release it before allowing a retry.
          if (typeof cleanup === 'function') {
            try { await cleanup(); } catch (e) {}
          }
          throw error;
        } finally {
          this._starting = null;
        }
      })();
      return this._starting;
    }

    async stop() {
      const startup = this._starting;
      if (startup) {
        try { await startup; } catch (e) {}
      }
      const cleanup = this._cleanup;
      this._cleanup = null;
      if (cleanup) await cleanup();
    }
  }

  const api = { MicStartupGate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AriaMicLifecycle = api;
})(typeof self !== 'undefined' ? self : this);
