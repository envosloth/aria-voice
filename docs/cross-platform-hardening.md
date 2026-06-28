# Cross-Platform Hardening Checklist

Goal: ARIA must run natively and correctly on **Windows**, **macOS**, and **all
major Linux flavors** — not just the Ubuntu/AMD dev target. The code was written
Linux-first and carries several Linux-only assumptions that hard-crash or silently
break core flows on other OSes (e.g. the `safeStorage.getSelectedStorageBackend`
crash on Windows boot).

This file is the source of truth for the cross-platform hardening loop. Work
through it item by item. Each fix MUST:

- Be **platform-guarded** so the existing **Linux runtime behavior is unchanged**
  (new branches activate only on `win32`/`darwin`). This machine is Linux, so
  Linux is the regression guard.
- Keep `npm run typecheck` clean and `npm run smoke:all` green.
- Prefer Node/Electron cross-platform APIs over shelling out.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done (verified typecheck +
relevant smoke) · `[!]` blocked/needs human (note why).

---

## A. IPC transport — Unix domain sockets (HIGH)
The PCM data channel uses filesystem `.sock` files. Node `net` on Windows cannot
listen on a filesystem socket path — it needs a named pipe (`\\.\pipe\<name>`).
The Python side uses `socket.AF_UNIX`. Both ends must agree per platform.

- [x] A4. DECISION: per-platform transport, encoded in the `--socket` arg string.
  POSIX (linux/macOS) keeps the filesystem UDS path (Linux unchanged, macOS native);
  Windows uses **loopback TCP** `tcp://127.0.0.1:<ephemeral>` (Node can't serve a
  UDS file path on Windows, and driving a named pipe from Python needs pywin32).
  Both ends agree on the convention: path => AF_UNIX, `tcp://host:port` => AF_INET.
- [x] A1/A2. `src/main/supervisor.ts` start(): win32 branch does
  `server.listen(0,'127.0.0.1')` + builds `tcp://127.0.0.1:<port>`; POSIX branch
  is byte-for-byte the original UDS path (mkdir+unlink+listen). Verified Linux
  smoke (supervisor/tts/stt) still PASS.
- [x] A3. `sidecars/shared/base_sidecar.py` `_connect_socket`: parses `tcp://`
  -> AF_INET, else AF_UNIX. AF_UNIX is never referenced on Windows (some Python
  builds lack it). `--socket` help text updated.

## B. Process lifecycle / kill (HIGH)
- [x] B1. Added `killTree(pid, force)` helper: POSIX signals the process group
  via negative PID (SIGTERM/SIGKILL, unchanged); Windows runs `taskkill /PID
  <pid> /T /F`. Both killSidecar call sites use it. Verified resilience +
  supervisor (0 orphans) on Linux.
- [x] B2. `spawn` opts now `detached: process.platform !== 'win32'` (POSIX
  unchanged) + `windowsHide: true` so Windows doesn't pop a console.
- [x] B3. Linux keeps `prctl` PR_SET_PDEATHSIG (unchanged; pdeathsig smoke PASS).
  Added non-Linux daemon backstop: macOS polls `getppid()` for reparenting;
  Windows polls the parent PID via `OpenProcess`/`GetExitCodeProcess` (ctypes,
  stdlib). Both `os._exit(0)` when the parent dies. Degrades to no-op on error.
- [x] B4. Signal registration now loops SIGTERM/SIGINT/SIGBREAK with
  getattr+try/except (Linux still registers SIGTERM+SIGINT identically; Windows
  also gets SIGBREAK; never crashes startup).

## C. Sidecar binary & venv path resolution (HIGH)
- [x] C1. `resolveSidecarCommand` frozen path now appends `.exe` on win32.
- [x] C2. venv python resolves `venv/Scripts/python.exe` on win32 (else
  `venv/bin/python`), system fallback `python` on win32 (else `python3`).

## D. Auto-updater channel selection (HIGH)
- [x] D1. `deliveryChannel()` now returns `win`/`mac` (checked before APPIMAGE so
  Linux is unchanged); added `usesElectronUpdater()` and `initUpdater` wires the
  autoUpdater for appimage/win/mac. NSIS (Win) + dmg-zip (Mac) self-update.
  CAVEAT: macOS auto-apply needs a signed app; unsigned builds degrade to
  notify (acceptable). Updater + update-progress smoke PASS.
- [x] D2. `installDebUpdate` (pkexec/dpkg) is only reachable via `pendingDeb`,
  which is only set when `deliveryChannel()==='deb'`. Win/Mac route to
  `autoUpdater.quitAndInstall`, so pkexec can never run off-Linux.

## E. Secure storage (DONE)
- [x] E1. `src/main/secure-storage.ts` `getSelectedStorageBackend()` is Linux-only
  — guarded to return `dpapi` (win32) / `keychain` (darwin); the live crash fix.

## F. Paths & shell assumptions (MEDIUM)
- [x] F1. `json-store.ts` fallback now `path.join(os.homedir() || os.tmpdir(),
  '.aria')` (cross-platform; Linux fallback equivalent). Only used outside Electron.
- [x] F2. Swept `src/main`. `hardware.ts` GPU detection was Linux-only (vulkaninfo/
  lspci/DRM sysfs) — degraded safely but returned "Unknown GPU" on Win/Mac. Added
  `detectGpuWindows` (PowerShell CIM) + `detectGpuMac` (system_profiler); Linux
  path unchanged (hardware smoke PASS). `pkexec` is the only other shell-out and
  is gated to the deb channel (D2). No other raw POSIX literals.
- [x] F3. `package-sidecar.sh` already Win/Mac-aware (venv Scripts + `.exe`).
  `stage-whisper.sh` + `build-whispercpp.sh` made cross-platform — see I1/I2.

## I. whisper.cpp staging + STT sidecar resolution (HIGH — newly found)
STT depends on staged whisper.cpp binaries+libs. The Python resolver assumed Linux
names/paths, and the staging script only handles Linux artifacts.
- [x] I3. `sidecars/stt/main.py` `_find_binary`: now appends `.exe` on Windows and
  `shutil.which(exe)`-first. `_env`: sets `PATH` (win) / `DYLD_LIBRARY_PATH` (mac)
  / `LD_LIBRARY_PATH` (linux, unchanged) with `os.pathsep`. STT smoke PASS on Linux.
- [x] I1. `scripts/stage-whisper.sh` rewritten cross-platform: per-OS exe suffix
  + lib globs (Linux `.so`, macOS `.dylib`, Windows `.exe`+`.dll`, DLLs searched
  next to the exe too). Linux staging verified identical (STT runs against the
  freshly-staged bin/lib, Vulkan, correct transcription). CI VERIFY: Win/Mac
  artifact paths on their native runners (cannot build whisper.cpp here).
- [x] I2. `scripts/build-whispercpp.sh` rewritten with per-OS backend: Linux
  Vulkan + strict checks (unchanged), macOS `-DGGML_METAL=1`, Windows Vulkan-if-SDK
  -else-CPU; portable core count (nproc/sysctl/NUMBER_OF_PROCESSORS). Linux branch
  logic + syntax verified. CI VERIFY: actual Win/Mac compile on native runners.
- [x] I4. `_find_model` now reads `ARIA_MODELS_DIR` first; `model-manager.ts`
  exports the effective dir to `process.env.ARIA_MODELS_DIR` so the main process
  and STT sidecar never disagree (the dir uses `os.homedir()`, cross-platform).
  Legacy XDG fallbacks kept. STT + models smoke PASS.

## G. UI / OS integration (LOW)
- [x] G1. Tray used `nativeImage.createEmpty()` (invisible in Win tray / macOS
  menu bar). Now loads `assets/icon.png` on win32/darwin (resized 18px for macOS),
  Linux unchanged (empty). Bundled the icon via electron-builder `files` so the
  path resolves inside the asar. Headless boot smoke PASS (window+tray init).
  globalShortcut + Wayland guard already best-effort/Linux-scoped — fine.
- [x] G2. Already correct: app menu uses `{ role: 'editMenu' }`, which Electron
  maps to Cmd on macOS / Ctrl elsewhere automatically. No hardcoded accelerators.

## H. Build / packaging (verify only)
- [x] H1. `electron-builder.yml` has `win` (nsis+portable) and `mac` (dmg+zip)
  targets, and `release.yml` builds each OS on its native runner. Config OK.
- [x] H2. Verified end-to-end naming is consistent: `package-sidecar.sh` freezes
  to `build/sidecars/<name>/<name>(.exe)` (BINEXT=.exe on Windows) -> electron-builder
  maps `build/sidecars`->`sidecars` -> `<resources>/sidecars/<name>/<name>(.exe)` ->
  `resolveSidecarCommand` looks for `name + exe` (C1). All three agree per-OS.

---

## Verification per iteration
1. `npm run build` then `npm run typecheck` — must be clean.
2. Run the smoke test(s) covering touched areas (e.g. `smoke:resilience` for
   supervisor lifecycle, `smoke` for sidecar IPC).
3. Before declaring completion, run full `npm run smoke:all` — must be green
   (Linux behavior unchanged).

## Completion
When every `[ ]`/`[~]` above is `[x]` or `[!]` (with reason), typecheck is clean,
and `npm run smoke:all` is green, the loop is done.
