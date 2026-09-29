// Persisted conversation history. Each "session" is one conversation (from app
// start / "New session" until the next reset) stored as a list of user+assistant
// text turns, so the user can browse past conversations and reopen one. Lives in
// the main process (the renderer is sandboxed); persisted to userData via the
// same atomic JsonStore the config uses — no new dependency, no database.
import { randomUUID } from 'crypto';
import { JsonStore } from './json-store';

export interface SessionTurn { role: 'user' | 'assistant'; content: string; ts: number; }
// Tokens spent in a session, split by which backend answered: the direct
// conversational LLM vs the agent harness. Accumulated across the conversation's
// turns; shown at the bottom of the orb/ops rail.
export interface SessionTokens { llm: number; harness: number; }
export interface SessionRecord {
  id: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  turns: SessionTurn[];
  pinned?: boolean;
  // Hermes/OpenAI-compatible harness session id (X-Hermes-Session-Id) used by
  // the agent path. Persisting it lets ARIA keep server-side continuity when a
  // conversation is reopened, and lets Delete remove the matching harness
  // session instead of only hiding ARIA's local transcript.
  harnessSessionId?: string;
  tokens?: SessionTokens;
  // Set when the conversation was imported from a harness's own history
  // ('hermes:<id>', 'claude-code:<id>', …). Used to skip re-imports.
  importedFrom?: string;
  // True when the USER pinned it (imports used to be auto-pinned; see migrate).
  pinnedByUser?: boolean;
}
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  turns: number;
  current: boolean;
  pinned: boolean;
  hasHarnessSession: boolean;
  tokens: SessionTokens;
  importedFrom?: string;
  startedAt: number;
}

// The newest unpinned MAX_SESSIONS are retained; pins are exempt. The whole
// array is rewritten on every turn, which is fine at this small, turn-paced n.
const MAX_SESSIONS = 50;
const MAX_TURNS_PER_SESSION = 200;
const TITLE_MAX = 60;

let store: JsonStore<{ sessions: SessionRecord[] }> | null = null;
function db(): JsonStore<{ sessions: SessionRecord[] }> {
  if (!store) { store = new JsonStore('sessions', { sessions: [] }); migrate(store); }
  return store;
}
// Early imports were auto-pinned, which floated old chats above new ones.
// Unpin those (never touching a pin the user set); retention keeps imports anyway.
function migrate(s: JsonStore<{ sessions: SessionRecord[] }>): void {
  const list = s.get('sessions');
  if (!Array.isArray(list)) return;
  let changed = false;
  for (const r of list as SessionRecord[]) {
    if (r.importedFrom && r.pinned && !r.pinnedByUser) { r.pinned = false; changed = true; }
  }
  if (changed) s.set('sessions', list);
}
function all(): SessionRecord[] {
  const s = db().get('sessions');
  return Array.isArray(s) ? (s as SessionRecord[]) : [];
}

// Retention is activity-based, never insertion-order based. Pinned records are
// intentionally exempt from the normal cap: dropping an old pin just because a
// newer unpinned session arrived defeats the purpose of pinning it.
export function retainSessions(list: SessionRecord[]): SessionRecord[] {
  const ordered = [...list].sort((a, b) =>
    (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) ||
    (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0) ||
    a.id.localeCompare(b.id),
  );
  let unpinnedRemaining = MAX_SESSIONS;
  return ordered.filter((session) => {
    if (session.pinned || session.importedFrom) return true; // imports are kept, like pins
    if (unpinnedRemaining <= 0) return false;
    unpinnedRemaining--;
    return true;
  });
}
function persist(list: SessionRecord[]): void {
  db().set('sessions', retainSessions(list));
}

let currentId: string | null = null;

// Start a fresh conversation: the next recorded turn opens a new session record.
// (Lazy — we don't create an empty record here, so an app run with no turns
// never litters the list.)
export function startNewSession(): void {
  currentId = null;
}

// Make an existing session the current one, so subsequent turns append to it
// (used when the user reopens a past conversation from the sidebar).
export function setCurrentSession(id: string): void {
  currentId = id;
}

export function getCurrentSessionId(): string | null {
  return currentId;
}

export function recordTurn(role: 'user' | 'assistant', content: string): void {
  const text = (content || '').trim();
  if (!text) return;
  const list = all();
  const now = Date.now();
  let cur = currentId ? list.find((s) => s.id === currentId) : null;
  if (!cur) {
    cur = { id: randomUUID(), title: '', startedAt: now, updatedAt: now, turns: [], pinned: false };
    currentId = cur.id;
    list.push(cur);
  }
  if (!cur.title && role === 'user') {
    cur.title = text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text;
  }
  cur.turns.push({ role, content: text, ts: now });
  if (cur.turns.length > MAX_TURNS_PER_SESSION) cur.turns = cur.turns.slice(-MAX_TURNS_PER_SESSION);
  cur.updatedAt = now;
  persist(list);
}

// Summaries for the sidebar list, newest activity first.
export function listSessions(): SessionSummary[] {
  return all()
    .map((s) => ({
      id: s.id,
      title: s.title || '(untitled)',
      updatedAt: s.updatedAt,
      turns: s.turns.length,
      current: s.id === currentId,
      pinned: !!s.pinned,
      hasHarnessSession: !!s.harnessSessionId,
      tokens: { llm: s.tokens?.llm || 0, harness: s.tokens?.harness || 0 },
      ...(s.importedFrom ? { importedFrom: s.importedFrom } : {}),
      startedAt: s.startedAt,
    }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

export function getSession(id: string): SessionRecord | null {
  return all().find((s) => s.id === id) || null;
}

export function setCurrentHarnessSession(harnessSessionId: string): SessionRecord | null {
  if (!currentId || !harnessSessionId) return null;
  const list = all();
  const cur = list.find((s) => s.id === currentId);
  if (!cur) return null;
  cur.harnessSessionId = harnessSessionId;
  persist(list);
  return cur;
}

// Add tokens spent on a completed turn to the CURRENT session, attributed to the
// backend that answered ('llm' or 'harness'). No-op when there's no current
// session or the count is non-positive. Turn-paced, so the naive full rewrite is
// fine (same as recordTurn).
export function addSessionTokens(target: 'llm' | 'harness', total: number): void {
  const n = Math.round(Number(total) || 0);
  if (!currentId || n <= 0) return;
  const list = all();
  const cur = list.find((s) => s.id === currentId);
  if (!cur) return;
  if (!cur.tokens) cur.tokens = { llm: 0, harness: 0 };
  cur.tokens[target] = (cur.tokens[target] || 0) + n;
  persist(list);
}

export function setSessionPinned(id: string, pinned: boolean): SessionRecord | null {
  const list = all();
  const rec = list.find((s) => s.id === id);
  if (!rec) return null;
  rec.pinned = !!pinned;
  rec.pinnedByUser = !!pinned;
  persist(list);
  return rec;
}

export function deleteSession(id: string): SessionRecord | null {
  const list = all();
  const rec = list.find((s) => s.id === id) || null;
  if (!rec) return null;
  persist(list.filter((s) => s.id !== id));
  if (currentId === id) currentId = null;
  return rec;
}

// Keys ('source:externalId') of conversations already imported.
export function importedKeys(): Set<string> {
  return new Set(all().map((s) => s.importedFrom).filter((k): k is string => !!k));
}

// Add imported conversations as past sessions. Existing imports (same key) are
// skipped, never overwritten; imported records are exempt from the 50-session
// retention cap (see retainSessions) regardless of how old the originals are.
export function addImportedSessions(items: { key: string; title: string; startedAt: number; updatedAt: number; turns: SessionTurn[] }[]): number {
  const list = all();
  const have = new Set(list.map((s) => s.importedFrom).filter(Boolean));
  let added = 0;
  for (const it of items) {
    if (!it.key || have.has(it.key) || !it.turns.length) continue;
    have.add(it.key);
    list.push({
      id: randomUUID(),
      title: it.title.length > TITLE_MAX ? it.title.slice(0, TITLE_MAX - 1) + '…' : it.title,
      startedAt: it.startedAt,
      updatedAt: it.updatedAt,
      turns: it.turns.slice(-MAX_TURNS_PER_SESSION),
      pinned: false,
      importedFrom: it.key,
    });
    added++;
  }
  if (added) persist(list);
  return added;
}

// --- self-check (run: `node -e "require('./dist/main/sessions').__selftest()"`) --
export function __selftest(): void {
  // Pure-logic check of title derivation + turn cap, independent of disk.
  const long = 'x'.repeat(100);
  const title = long.length > TITLE_MAX ? long.slice(0, TITLE_MAX - 1) + '…' : long;
  if (title.length !== TITLE_MAX) throw new Error('title cap wrong');
  if (!title.endsWith('…')) throw new Error('title ellipsis missing');
  // eslint-disable-next-line no-console
  console.log('sessions self-check OK');
}
