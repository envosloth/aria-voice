// Context awareness (roadmap P0.3), capture half: read the desktop context an
// utterance referred to. Called only for the kinds context-refs.ts detected and
// only for sources the user enabled (context.* config, all off by default).
//
// Platform support is explicit, not assumed:
//   active window — Hyprland (hyprctl), Sway (swaymsg), X11 (xdotool);
//                   otherwise unavailable, and the UI says so.
//   selection     — Wayland primary selection (wl-paste --primary) or X11
//                   PRIMARY via Electron; unavailable on Windows/macOS.
//   clipboard     — wl-paste on Wayland (Electron reads "" there while
//                   another app is focused); Electron clipboard elsewhere.
// Every probe has a hard timeout so a hung compositor can never stall a turn.

import { clipboard } from 'electron';
import { execFile } from 'child_process';
import fs from 'fs';
import type { ActiveApp, ContextKind, ContextSnapshot } from './context-refs';

const PROBE_TIMEOUT_MS = 400;
const MAX_CAPTURE_CHARS = 20000;

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

export function activeWindowBackend(): 'hyprland' | 'sway' | 'x11' | null {
  if (process.platform !== 'linux') return null;
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) return 'hyprland';
  if (process.env.SWAYSOCK) return 'sway';
  if (process.env.DISPLAY && process.env.XDG_SESSION_TYPE !== 'wayland') return 'x11';
  return null;
}

export function selectionBackend(): 'wayland' | 'x11' | null {
  if (process.platform !== 'linux') return null;
  if (process.env.WAYLAND_DISPLAY) return 'wayland';
  if (process.env.DISPLAY) return 'x11';
  return null;
}

/**
 * The window the user is working in. When ARIA itself has focus (they clicked
 * into ARIA to type "summarize this"), the answer is the window they came
 * from: on Hyprland that is focusHistoryID 1; elsewhere the last external
 * window main has sampled (see noteExternalWindow).
 */
async function activeWindow(ownPid: number): Promise<ActiveApp | null> {
  switch (activeWindowBackend()) {
    case 'hyprland': {
      const out = await run('hyprctl', ['clients', '-j']);
      try {
        const clients = (JSON.parse(out || '[]') as any[]).filter((c) => c && c.mapped !== false)
          .sort((a, b) => (a.focusHistoryID ?? 99) - (b.focusHistoryID ?? 99));
        const pick = clients.find((c) => !isOwn(c.pid, ownPid, c.class, c.title));
        return pick ? { app: String(pick.class || ''), title: String(pick.title || '') } : null;
      } catch { return null; }
    }
    case 'sway': {
      void ownPid;
      const out = await run('swaymsg', ['-t', 'get_tree']);
      try {
        const find = (n: any): any => (n.focused ? n : (n.nodes || []).concat(n.floating_nodes || []).map(find).find(Boolean));
        const f = find(JSON.parse(out || '{}'));
        return f ? { app: String(f.app_id || f.window_properties?.class || ''), title: String(f.name || '') } : null;
      } catch { return null; }
    }
    case 'x11': {
      const title = await run('xdotool', ['getactivewindow', 'getwindowname']);
      const cls = await run('xdotool', ['getactivewindow', 'getwindowclassname']);
      return title || cls ? { app: (cls || '').trim(), title: (title || '').trim() } : null;
    }
    default:
      return null;
  }
}

async function primarySelection(): Promise<string> {
  const backend = selectionBackend();
  if (backend === 'wayland') {
    const out = await run('wl-paste', ['--primary', '--no-newline', '--type', 'text/plain']);
    return out && !/^No selection/i.test(out) ? out : '';
  }
  if (backend === 'x11') {
    try { return clipboard.readText('selection') || ''; } catch { return ''; }
  }
  return '';
}

function isOwn(pid: unknown, ownPid: number, cls: unknown, title: unknown): boolean {
  if (typeof pid === 'number' && pid > 0 && isDescendantOrSelf(pid, ownPid)) return true;
  return isAriaWindow({ app: String(cls || ''), title: String(title || '') });
}
// Electron's window belongs to a child renderer/GPU process of the main pid on
// some compositors, to the main pid on others; check the parent chain.
function isDescendantOrSelf(pid: number, ancestor: number): boolean {
  let p = pid;
  for (let i = 0; i < 6 && p > 1; i++) {
    if (p === ancestor) return true;
    try { p = Number(fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1]); } catch { return false; }
  }
  return false;
}

let lastExternal: ActiveApp | null = null;
/** Remember the last non-ARIA window seen (non-Hyprland fallback). */
export function noteExternalWindow(w: ActiveApp | null): void {
  if (w && !isAriaWindow(w)) lastExternal = w;
}

// Electron's clipboard reads "" under Wayland unless an ARIA window holds
// keyboard focus (verified on Hyprland 2026-09), which is exactly when the user
// is NOT pointing at another app. wl-paste talks to the compositor directly.
async function readClipboard(): Promise<string> {
  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
    const out = await run('wl-paste', ['--no-newline', '--type', 'text/plain']);
    if (out !== null) return /^Nothing is copied/i.test(out) ? '' : out;
  }
  try { return clipboard.readText() || ''; } catch { return ''; }
}

export interface ContextSources { activeApp: boolean; selection: boolean; clipboard: boolean }

/** Capture only what was referenced AND enabled by the user. */
export async function captureContext(refs: ContextKind[], enabled: ContextSources,
  ownPid: number = process.pid): Promise<ContextSnapshot> {
  const want = new Set(refs);
  const snap: ContextSnapshot = {};
  const jobs: Promise<void>[] = [];
  if ((want.has('activeApp') || want.has('page')) && enabled.activeApp) {
    jobs.push(activeWindow(ownPid).then((w) => {
      if (w && !isAriaWindow(w)) { lastExternal = w; snap.activeApp = w; } else snap.activeApp = lastExternal;
    }));
  }
  if (want.has('selection') && enabled.selection) {
    jobs.push(primarySelection().then((s) => { snap.selection = s.slice(0, MAX_CAPTURE_CHARS); }));
  }
  if ((want.has('clipboard') || want.has('page')) && enabled.clipboard) {
    jobs.push(readClipboard().then((c) => { snap.clipboard = c.slice(0, MAX_CAPTURE_CHARS); }));
  }
  await Promise.all(jobs);
  return snap;
}

export function isAriaWindow(w: ActiveApp | null): boolean {
  return !!w && (/^aria$/i.test(w.app) || (/^electron$/i.test(w.app) && /\bARIA\b/.test(w.title)));
}

export async function sampleActiveWindow(ownPid: number = process.pid): Promise<ActiveApp | null> {
  return activeWindow(ownPid);
}
