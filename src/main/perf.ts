// Lightweight structured latency instrumentation for the interaction hot path.
//
// OFF by default — when disabled every perfMark() is a single boolean check and
// an immediate return, so it adds nothing to the latency it measures. Enable
// with the env var ARIA_PERF=1 (or "true") or the config flag `debug.perf`.
//
// Every mark emits ONE grep-able line:
//   [ARIA_PERF] turn=<id> stage=<name> t=<epochMs> proc=<main|renderer> [k=v ...]
//
// To read a run: `grep ARIA_PERF <log>`. Marks for a single interaction share a
// turn id (generated in the renderer when the user submits a turn and threaded
// through IPC), so per-stage deltas are `t(stage_b) - t(stage_a)` within a turn.
// Diff before/after a change by comparing those deltas for the same stages.
//
// Standard stage names (so greps are stable across the codebase):
//   text chat : user_input -> dispatch -> main_recv -> llm_request -> first_token
//               -> first_token_render -> llm_done -> turn_complete
//   voice     : audio_start -> audio_end -> stt_transcribe_req -> stt_result
//               -> (then the text-chat stages for the recognized text)
//   tts       : tts_first_request -> tts_first_audio

let enabled = process.env.ARIA_PERF === '1' || process.env.ARIA_PERF === 'true';

export function perfEnabled(): boolean {
  return enabled;
}

// Lets a runtime toggle (e.g. a future debug command or a config flag read at
// boot) flip instrumentation on/off without a restart.
export function setPerfEnabled(v: boolean): void {
  enabled = v;
}

export interface PerfMark {
  turn: string;
  stage: string;
  t: number;
  proc: 'main' | 'renderer';
  extra?: Record<string, unknown>;
}

// Bounded ring buffer of recent marks so a debugger can dump the last interaction
// without scraping stdout. Capped so it can't grow during a long session.
const RING_SIZE = 512;
const ring: PerfMark[] = [];
export function recentMarks(): PerfMark[] {
  return ring.slice();
}

function push(m: PerfMark): void {
  ring.push(m);
  if (ring.length > RING_SIZE) ring.shift();
}

function fmtExtra(extra?: Record<string, unknown>): string {
  if (!extra) return '';
  const parts: string[] = [];
  for (const k of Object.keys(extra)) parts.push(`${k}=${extra[k]}`);
  return parts.length ? ' ' + parts.join(' ') : '';
}

function emit(m: PerfMark): void {
  push(m);
  console.log(`[ARIA_PERF] turn=${m.turn} stage=${m.stage} t=${m.t} proc=${m.proc}${fmtExtra(m.extra)}`);
}

// Record a stage boundary reached in the main process.
export function perfMark(turn: string | number, stage: string, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  emit({ turn: String(turn), stage, t: Date.now(), proc: 'main', extra });
}

// Record a mark that originated in the renderer (forwarded over IPC). The
// renderer supplies its own timestamp so the time reflects when the UI event
// actually happened, not when main got around to logging it.
export function perfMarkExternal(mark: {
  turn: string | number;
  stage: string;
  t?: number;
  extra?: Record<string, unknown>;
}): void {
  if (!enabled) return;
  emit({ turn: String(mark.turn), stage: mark.stage, t: mark.t || Date.now(), proc: 'renderer', extra: mark.extra });
}
