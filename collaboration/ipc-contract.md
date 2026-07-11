# IPC Contract

Two IPC boundaries. Get either subtly wrong and things fail silently (dropped
audio, a wedged sidecar, a reply that never renders). Both are verified against the
code below.

## 1. Main ↔ Sidecar (`base_sidecar.py` + `supervisor.ts`)

Three channels per sidecar:

| Direction | Channel | Format |
|-----------|---------|--------|
| main → sidecar | **stdin** | one JSON object per line (`supervisor.sendToSidecar`) |
| main ↔ sidecar | **UDS** (or `tcp://` on Windows) | raw PCM bytes (`supervisor.sendPcm` / `onBinaryData`) |
| sidecar → main | **stdout** | one JSON object per line: results, status, heartbeats, `log` |

Rules learned the hard way:

- **stdout is line-framed JSON, and lines split across read chunks.** The supervisor
  buffers a partial line per sidecar until the newline (`stdoutBuf`, reset on
  respawn, capped). If you emit from Python, emit whole JSON lines via `self.emit()`.
- **PCM is a byte stream with no framing.** UDS segments are *not* aligned to the
  2-byte sample boundary. The consumer must carry a trailing odd byte into the next
  segment (renderer does this in `onAudio`; a barge-in must reset that carry byte).
- **STT controls and PCM have no cross-channel ordering guarantee.** Main sends
  `{type:"start", utterance_id}` and queues mic PCM until the sidecar replies with
  `stt_started` for that ID. `transcribe` includes `audio_bytes`; the sidecar waits
  (up to 120 ms, only when bytes are actually late) until that many bytes have
  reached its buffer. Do not replace this with an unacknowledged `reset` followed
  immediately by socket writes — the reset can erase the first frame, while an
  end control can overtake the final frame and clip the last word.
- **Every STT result is turn-correlated and exactly-once.** The sidecar echoes
  `utterance_id` in `stt_result`; main's `SttTurnGate` rejects stale/duplicate
  results and sends `{text, turnId}` over `STT_RESULT`. The renderer checks the ID
  again before creating a user chat turn. Preserve all three layers when changing
  the voice pipeline.
- **`--socket`** is passed to every sidecar: a UDS path on POSIX, a `tcp://host:port`
  URL on Windows (no `AF_UNIX` there). `base_sidecar._connect_socket` branches on the
  `tcp://` prefix.
- **Blocking reads must notice EOF.** An empty blocking `recv` sets `_running=False`
  (a past bug spun the loop at 100% CPU on socket EOF).
- **Parent-death safety.** Sidecars watch the parent PID and exit if orphaned
  (`_watch_parent_*`), backing up the supervisor's tree-kill + Linux `PR_SET_PDEATHSIG`.

### Writing / changing a sidecar

Subclass `BaseSidecar` and implement only:

```python
def initialize(self):        # load models, warm engines; runs once at start
def on_control(self, msg):   # a JSON control message arrived on stdin
def on_pcm(self, data):      # raw PCM bytes arrived on the UDS (stt/wakeword)
```

Emit results/status with `self.emit({...})`; send audio with `self.send_pcm(bytes)`.
The base class handles args, the socket, stdin/heartbeat loops, signals, and
parent-death. Each sidecar has its own `requirements.txt` and venv; the supervisor
auto-detects `sidecars/<name>/venv` in dev, or a frozen binary via
`ARIA_SIDECAR_DIR`. Freeze with `scripts/package-sidecar.sh <name>`.

### Supervisor guarantees

`supervisor.ts` gives you: heartbeat liveness, **auto-restart with a circuit
breaker** (opens after N consecutive failures, resets after a cooldown), an **RSS
memory watchdog** per sidecar (`rssLimitsMb`, checked every `memoryCheckMs`), and
**tree-kill on quit** (no orphans). Status flows through the `onStatus(name, status,
detail)` callback → `SIDECAR_STATUS` / `SIDECAR_ERROR`.

## 2. Main ↔ Renderer (`src/shared/ipc-channels.ts` + preload)

The renderer is sandboxed. It cannot `require`, touch the filesystem, or open
sockets. It talks to main **only** through the `aria.*` object exposed by
`src/preload/index.ts` via `contextBridge`. Every channel name lives in the `IPC`
registry — import it, never hardcode the string.

Channel families (see `ipc-channels.ts` for the full list + inline docs):

- `MIC_AUDIO`, `STT_*` — mic frames in; utterance start/end; partial/final text.
- `TTS_PLAY/STOP/AUDIO/STATE` — synthesis requests; PCM chunks + chunk/done events.
- `WAKEWORD_DETECTED/STATE`.
- `LLM_SEND/CANCEL/RESET`, `LLM_TOKEN/TOOL/DONE/ERROR/ROUTE`, `LLM_TEST/LIST_MODELS/DETECT_HARNESS`.
- `CONFIG_GET/SET`, `SESSIONS_LIST/GET/DELETE/PIN/RESUME`, `SECURE_STORE_*`.
- `HARDWARE_INFO`, `PERF_*`, `UPDATE_*`, `TUNNEL_*`.

### Adding a renderer↔main call

1. Add the channel to `IPC` in `src/shared/ipc-channels.ts` (with a `// direction:`
   comment).
2. Register the handler in `setupIpcHandlers()` in `index.ts` (`ipcMain.handle` for
   request/response, `ipcMain.on` for fire-and-forget, `webContents.send` for
   push-to-renderer).
3. Expose it on the `aria.*` surface in `src/preload/index.ts`.
4. Call it from `app.js`.

Miss step 3 and the renderer silently has no way to call it — the sandbox is the
whole point.
