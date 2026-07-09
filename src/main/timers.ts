// Timers, alarms and reminders, scheduled in the main process and persisted so
// they survive a restart. Firing announces through the callback wired in
// index.ts (renderer transcript line + spoken TTS), which works with the
// window hidden in the tray. Parsing lives in local-intents.ts; the
// coordinator calls create/list/cancel.

import { randomUUID } from 'crypto';
import { JsonStore } from './json-store';

export interface TimerRec {
  id: string;
  kind: 'timer' | 'alarm' | 'reminder';
  label: string;   // "10 minutes" / "7:30 AM" / the reminder text
  fireAt: number;  // epoch ms
  createdAt: number;
}

type FireCallback = (announcement: string, rec: TimerRec) => void;

// Missed firings (app was closed) are announced once on next boot if they are
// less than this stale; older ones are dropped silently.
const MISSED_GRACE_MS = 3600000;

let store: JsonStore<{ items: TimerRec[] }> | null = null;
const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
let onFire: FireCallback = () => {};

function db(): JsonStore<{ items: TimerRec[] }> {
  if (!store) store = new JsonStore('timers', { items: [] });
  return store;
}
function all(): TimerRec[] {
  const items = db().get('items');
  return Array.isArray(items) ? (items as TimerRec[]) : [];
}
function persist(items: TimerRec[]): void {
  db().set('items', items);
}

export function announcementFor(rec: TimerRec): string {
  if (rec.kind === 'timer') return `Your ${rec.label} timer is done.`;
  if (rec.kind === 'alarm') return `It's ${rec.label}. This is your alarm.`;
  return `Here's your reminder: ${rec.label}.`;
}

function fire(rec: TimerRec, missed = false): void {
  timeouts.delete(rec.id);
  persist(all().filter((r) => r.id !== rec.id));
  onFire(missed ? `While I was closed — ${announcementFor(rec)}` : announcementFor(rec), rec);
}

function schedule(rec: TimerRec): void {
  const delay = Math.max(0, rec.fireAt - Date.now());
  timeouts.set(rec.id, setTimeout(() => fire(rec), delay));
}

/** Load persisted items: fire recently-missed ones once, drop stale ones, re-arm the rest. */
export function initTimers(cb: FireCallback): void {
  onFire = cb;
  const now = Date.now();
  for (const rec of all()) {
    if (rec.fireAt <= now) {
      if (now - rec.fireAt < MISSED_GRACE_MS) fire(rec, true);
      else persist(all().filter((r) => r.id !== rec.id)); // too stale — drop silently
    } else {
      schedule(rec);
    }
  }
}

export function createTimer(kind: TimerRec['kind'], label: string, fireAt: number): TimerRec {
  const rec: TimerRec = { id: randomUUID(), kind, label, fireAt, createdAt: Date.now() };
  persist([...all(), rec]);
  schedule(rec);
  return rec;
}

export function listTimers(): TimerRec[] {
  return all().slice().sort((a, b) => a.fireAt - b.fireAt);
}

export function cancelTimers(what: TimerRec['kind'] | 'all'): number {
  const items = all();
  const cancelled = items.filter((r) => what === 'all' || r.kind === what);
  for (const rec of cancelled) {
    const t = timeouts.get(rec.id);
    if (t) { clearTimeout(t); timeouts.delete(rec.id); }
  }
  persist(items.filter((r) => !(what === 'all' || r.kind === what)));
  return cancelled.length;
}
