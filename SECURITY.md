# Security Policy

ARIA runs a local voice pipeline and holds user-configured LLM/agent API keys, so
we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's **[Security Advisories](https://github.com/envosloth/aria-voice/security/advisories/new)**
("Report a vulnerability" on the repository's Security tab). If that's unavailable
to you, open a minimal public issue asking for a private contact channel — without
details.

Please include: affected version, platform, reproduction steps, and impact. We aim
to acknowledge within a few days and will keep you updated on the fix and
disclosure timeline.

## Supported versions

ARIA ships from `main` as rolling `v*` releases; only the **latest release** is
supported. Please reproduce on the current version before reporting.

## Scope — what we care about most

ARIA's sensitive surfaces:

- **API keys / secrets.** Keys are stored in the OS keyring via Electron
  `safeStorage` (gnome-keyring / libsecret on Linux). Reports about keys being
  written in plaintext, logged, leaked over IPC, or sent to an unintended endpoint
  are high priority.
- **The Electron sandbox.** The renderer is sandboxed (`contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`) and talks to the main process only
  through the `contextBridge` preload allowlist. Sandbox escapes or preload-surface
  abuse are in scope. Packaged builds must never run `--no-sandbox`.
- **Sidecar IPC.** Sidecars exchange control JSON over stdio and PCM over a Unix
  domain socket. Reports of untrusted input reaching a sidecar in a way that lets it
  execute code or read arbitrary files are in scope.
- **Remote endpoints.** ARIA streams to user-configured OpenAI-compatible endpoints
  and can tunnel to a remote harness over SSH. Reports about requests going to the
  wrong host, credential exposure in the tunnel, or SSRF-style issues are in scope.
- **Auto-update.** The updater downloads and applies releases; integrity/signature
  issues are in scope.

## Out of scope

- Vulnerabilities in the remote LLM/agent you configure (that's your endpoint).
- Issues requiring a already-compromised local machine or physical access.
- The documented dev-only `--no-sandbox` flag used in `npm run dev` / smoke tests.
