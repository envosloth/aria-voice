/** Small correlation gates shared by main-process voice IPC paths. */

export interface LlmGeneration {
  turnId: string;
  generationId: number;
}

/** Keeps callbacks from an interrupted LLM stream out of the next turn. */
export class LlmGenerationGate {
  private active: LlmGeneration | null = null;

  begin(turnId: string, generationId: number): LlmGeneration {
    if (!turnId) throw new Error('LLM turn id is required');
    if (!Number.isFinite(generationId)) throw new Error('LLM generation id is required');
    this.active = { turnId, generationId };
    return this.active;
  }

  isCurrent(generation: LlmGeneration | null | undefined): boolean {
    return !!generation && !!this.active
      && generation.turnId === this.active.turnId
      && generation.generationId === this.active.generationId;
  }

  cancel(generation?: LlmGeneration): void {
    // A late cancel belongs to an older renderer action; it must not abort a
    // reply that started after that action was sent.
    if (!generation || this.isCurrent(generation)) this.active = null;
  }
}

export interface TtsChunkMetadata {
  replyId: string;
  requestId: string;
  epoch: number;
  size: number;
  sampleRate: number;
}

export interface TtsAudioPacket extends TtsChunkMetadata {
  pcm: Buffer<ArrayBufferLike>;
}

export interface TtsReplyDone {
  replyId: string;
  epoch: number;
}

const MAX_BUFFERED_TTS_BYTES = 16 * 1024 * 1024;

/**
 * Frames TTS's raw socket stream using the byte counts announced on stdout.
 * Metadata from a stopped epoch stays in the queue long enough to consume its
 * bytes, but delivery is gated to the active reply so stale tails cannot poison
 * the next reply's sample alignment.
 */
export class TtsAudioGate {
  private activeReplyId = '';
  private activeEpoch = -1;
  private pending: TtsChunkMetadata[] = [];
  private bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private replyDone: TtsReplyDone[] = [];
  private readyReplyDone: TtsReplyDone[] = [];

  activate(replyId: string, epoch: number): void {
    this.activeReplyId = replyId;
    this.activeEpoch = epoch;
  }

  announce(meta: TtsChunkMetadata): TtsAudioPacket[] {
    if (!meta.replyId || !meta.requestId || !Number.isFinite(meta.epoch)
      || !Number.isFinite(meta.size) || meta.size < 0 || !Number.isFinite(meta.sampleRate)) {
      return [];
    }
    this.pending.push(meta);
    return this.drain();
  }

  push(data: Buffer<ArrayBufferLike>): TtsAudioPacket[] {
    // Stdout metadata and socket PCM are independent transports, so either may
    // reach this process first. Keep a bounded pre-announcement buffer and clear
    // it only when the underlying sidecar transport is definitively replaced.
    if (data.length) {
      if (this.bytes.length + data.length > MAX_BUFFERED_TTS_BYTES) {
        this.resetTransport();
        return [];
      }
      this.bytes = this.bytes.length ? Buffer.concat([this.bytes, data]) : data;
    }
    return this.drain();
  }

  resetTransport(): void {
    this.pending = [];
    this.bytes = Buffer.alloc(0);
    this.replyDone = [];
    this.readyReplyDone = [];
  }

  markReplyDone(replyId: string, epoch: number): void {
    if (!replyId || !Number.isFinite(epoch)) return;
    if (!this.replyDone.some((done) => done.replyId === replyId && done.epoch === epoch)) {
      this.replyDone.push({ replyId, epoch });
    }
    this.flushReplyDone();
  }

  takeReplyDone(): TtsReplyDone[] {
    const ready = this.readyReplyDone;
    this.readyReplyDone = [];
    return ready;
  }

  private drain(): TtsAudioPacket[] {
    const packets: TtsAudioPacket[] = [];
    while (this.pending.length && this.bytes.length >= this.pending[0].size) {
      const meta = this.pending.shift()!;
      const pcm = this.bytes.subarray(0, meta.size);
      this.bytes = this.bytes.subarray(meta.size);
      if (meta.replyId === this.activeReplyId && meta.epoch === this.activeEpoch) {
        packets.push({ ...meta, pcm });
      }
    }
    this.flushReplyDone();
    return packets;
  }

  private flushReplyDone(): void {
    const stillPending: TtsReplyDone[] = [];
    for (const done of this.replyDone) {
      const hasAudio = this.pending.some((meta) => meta.replyId === done.replyId && meta.epoch === done.epoch);
      if (hasAudio) stillPending.push(done);
      else if (done.replyId === this.activeReplyId && done.epoch === this.activeEpoch) this.readyReplyDone.push(done);
    }
    this.replyDone = stillPending;
  }
}
