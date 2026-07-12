export interface TranscribeRequest {
  turnId: string;
  audioBytes: number;
}

export interface StartAckAction {
  chunks: Buffer[];
  transcribe: TranscribeRequest | null;
}

/**
 * Correlates the renderer's utterance with sidecar startup, PCM, and its result.
 *
 * Audio and controls use separate transports, so PCM is buffered until the
 * sidecar acknowledges that it cleared/reset the matching utterance. Results are
 * accepted exactly once and only for the current turn.
 */
export class SttTurnGate {
  private turnId: string | null = null;
  private captureOpen = false;
  private started = false;
  private endRequested = false;
  private transcribeSent = false;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private audioBytes = 0;

  constructor(private readonly maxPendingBytes = 1024 * 1024) {}

  begin(turnId: string): void {
    if (!turnId) throw new Error('STT turn id is required');
    this.turnId = turnId;
    this.captureOpen = true;
    this.started = false;
    this.endRequested = false;
    this.transcribeSent = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.audioBytes = 0;
  }

  isCurrent(turnId: string): boolean {
    return !!turnId && this.turnId === turnId;
  }

  /** Returns PCM for immediate sending, or null while startup is pending. */
  pushAudio(chunk: Buffer): Buffer | null {
    if (!this.captureOpen || chunk.length === 0) return null;
    this.audioBytes += chunk.length;
    if (this.started) return chunk;

    // Startup should be brief, but keep the queue bounded if a sidecar hangs.
    // Retain the earliest audio because clipped leading consonants hurt STT most.
    if (this.pendingBytes + chunk.length <= this.maxPendingBytes) {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
    } else {
      this.audioBytes -= chunk.length;
    }
    return null;
  }

  /** Applies the sidecar's start/reset acknowledgement for the matching turn. */
  ackStarted(turnId: string): StartAckAction | null {
    if (!this.isCurrent(turnId) || this.started) return null;
    this.started = true;
    const chunks = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    const transcribe = this.endRequested ? this.takeTranscribeRequest() : null;
    return { chunks, transcribe };
  }

  /** Closes capture and returns a request only when the sidecar is ready. */
  end(): TranscribeRequest | null {
    if (!this.turnId || this.endRequested) return null;
    this.captureOpen = false;
    this.endRequested = true;
    return this.started ? this.takeTranscribeRequest() : null;
  }

  /** Accepts the current result once; duplicate and stale results return false. */
  acceptResult(turnId: string): boolean {
    if (!this.isCurrent(turnId) || !this.transcribeSent) return false;
    this.turnId = null;
    this.captureOpen = false;
    this.started = false;
    this.endRequested = false;
    this.transcribeSent = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.audioBytes = 0;
    return true;
  }

  failStart(turnId: string): boolean {
    if (!this.isCurrent(turnId)) return false;
    this.turnId = null;
    this.captureOpen = false;
    this.started = false;
    this.endRequested = false;
    this.transcribeSent = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.audioBytes = 0;
    return true;
  }

  private takeTranscribeRequest(): TranscribeRequest | null {
    if (!this.turnId || this.transcribeSent) return null;
    this.transcribeSent = true;
    return { turnId: this.turnId, audioBytes: this.audioBytes };
  }
}
