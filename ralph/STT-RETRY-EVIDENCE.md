# Speech settings and brand retry — 2026-09-29

## Scope

A bounded voice-reliability increment on the existing roadmap, not completion of all twelve product features. The rejected implementation was reverted in `2a6876e`; this replacement does not repeat its unverified WM_CLASS diagnosis or change the launcher. Existing memory, context and routing work is preserved.

## Visible brand fix

The top-left mark was a CSS-gradient `div`, unrelated to the shortcut. It is now an `img` of the canonical `assets/icon.png`, copied to `dist/renderer/assets/icon.png`. The live Electron test checks the loaded image, its natural dimensions, canonical/distributed byte equality and equality with the installed 512 px shortcut asset. Screenshots of the built window were inspected. No compositor/window-list-icon claim is made.

## Speech path

- Local whisper.cpp stays default. Saved user configuration is not overwritten.
- Settings → Voice offers explicit Groq opt-in with a key, two supported models, upload notice, quota caveat and Data Controls notice. Audio is uploaded at finalisation only; speculative pauses never upload.
- Main passes the encrypted-storage credential only to the STT child through an injected environment callback. Switching providers or changing/deleting the key schedules a supervised reload. No global cloud-key environment mutation, new dependency or config-file credential.
- Empty cloud text is valid silence. HTTP/auth/quota failures, timeout and malformed responses fall back to the already warm local recogniser; failed local HTTP inference still uses the CLI fallback. Cloud redirects are rejected, response reads are bounded, exception text is not logged, and each network operation has a five-second socket timeout (not a wall-clock guarantee against drip-fed responses).
- Saved key input remains blank when reopened; blank means retain, not delete. Switching back to local stops future cloud use, retaining the encrypted credential for later opt-in. Secure IPC can delete it.
- Vocabulary is a bounded, explicit one-line hint, passed to local server/CLI or Groq; memories and clipboard content are never mined for it.
- Full audio context is optional and off by default. English-only small and Q5 variants have immutable pinned download metadata, exact sizes and SHA-256 checks. Q5 was downloaded, verified and exercised on this host.

## Measured local comparison

`npm run benchmark:stt-local -- MODEL [AUDIO_CTX]` synthesises eight known utterances with Piper's British Alan voice and runs the actual warm whisper.cpp server, CPU, two threads. Full transcripts and per-utterance measurements: [`scripts/stt-local-comparison.json`](../scripts/stt-local-comparison.json). One pass per setting; clean synthetic audio is **not** a noisy/human-speech benchmark, and these numbers measure STT only.

| Model/configuration | Median STT | Word errors |
| --- | ---: | ---: |
| small, short audio context | 3,503 ms | 2/61 |
| small.en Q5, short audio context | 4,415 ms | 2/61 |
| base.en, short audio context | 965 ms | 2/61 |
| base.en, vocabulary `Aria, Longmont, Blender.` | 1,203 ms | 0/61 |
| small, full audio context | 18,756.5 ms | 2/61 |

The two baseline word errors were `five` → `5` (formatting, not a semantic error) and `Aria` → `Area`. Vocabulary corrected the name in this small fixture. The full-context run overlapped a short UI smoke initially, so treat its timings as contextual rather than a controlled speed comparison. It showed no accuracy gain in this fixture; it is not recommended for latency on this CPU.

Q5 saved model storage but was slower, so it is not presented as a speed upgrade. `base.en` plus explicit vocabulary is the most promising tested local option here; the user's saved local selection is unchanged. No blanket accuracy claim is made.

A real HTTP 503 from a loopback fixture followed by actual base.en inference returned `What is the weather in Longmont, Colorado?` in 705 ms. This verifies real local fallback, not access to Groq.

## Focused verification

- Red-first live test originally failed on the gradient mark and missing provider controls; red-first transport tests failed on missing cloud functions.
- Build, lint and TypeScript passed during implementation.
- `smoke:stt-provider`: 10 Python transport/control cases, including a real loopback multipart server, plus 5 real-child Supervisor environment/restart checks.
- `smoke:stt-settings-live`: 15 actual Electron/CDP checks in a disposable profile with synthetic credentials; default privacy, missing-key rejection, encrypted storage, save/reopen/reload, blank-key preservation, local switch and narrow layout. Header, cloud and 1280/820 px settings screenshots inspected. The test explicitly shows its disposable smoke window to avoid hidden-window screenshot stalls; ordinary boot smokes remain hidden.
- All new focused checks are registered in `smoke:all`.
- The first full suite stopped on a pre-existing test contradiction: `smoke-barge-live.js` still expected interruptions off, while retained UX commit `fbd3bb3` intentionally made them default-on. Test-only correction `fa7bef6` now asserts the intended default; all other interruption checks remained strict and passed. No production default was changed.
- Final verification executed every one of the 53 registered `smoke:all` members serially, continuing beyond failures to avoid hiding later gates: 52 passed; only `smoke:e2e` missed its existing <900 ms CPU local-processing budget (1,173 ms median). Its isolated rerun also missed at 1,073 ms. No timing threshold was loosened. Build/lint/typecheck and `smoke:boot` passed. This is **not** an all-green/shippable result.
- Logs: `$TMPDIR/aria-stt-final-gates/results.json` and individual gate logs; isolated timing `$TMPDIR/aria-stt-e2e-isolated.log`; boot `$TMPDIR/aria-stt-boot-final.log`. The normal chain stops at its first failure, so the serial runner deliberately executed the remaining gates too.

## External facts and limits

Official documentation checked on 2026-09-29:

- https://console.groq.com/docs/speech-to-text — supported endpoint/models, multipart parameters, free-tier file-size limits, vocabulary hint.
- https://console.groq.com/docs/rate-limits — account-specific quotas; do not promise unlimited free use.
- https://console.groq.com/docs/your-data — customer input/output may be retained up to 30 days for reliability/abuse monitoring; all customers may enable zero-data-retention in Data Controls. Usage metadata remains collected. ARIA does not enable or verify that account setting.

No real Groq account key was supplied, so **live cloud latency, account quotas and speech accuracy have not been verified**. No cloud upload of user audio occurred in these tests. No new installer, release, push, real human-microphone test, true echo cancellation or streaming recogniser is claimed.
