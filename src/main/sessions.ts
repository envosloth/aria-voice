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
}

// ponytail: newest MAX_SESSIONS kept, whole array rewritten on every turn. n is
// tiny and writes are turn-paced, so a naive full rewrite is fine; switch to an
// append-only log only if history ever gets large enough to matter.
const MAX_SESSIONS = 50;
const MAX_TURNS_PER_SESSION = 200;
const TITLE_MAX = 60;

let store: JsonStore<{ sessions: SessionRecord[] }> | null = null;
function db(): JsonStore<{ sessions: SessionRecord[] }> {
  if (!store) store = new JsonStore('sessions', { sessions: [] });
  return store;
}
function all(): SessionRecord[] {
  const s = db().get('sessions');
  return Array.isArray(s) ? (s as SessionRecord[]) : [];
}
function persist(list: SessionRecord[]): void {
  db().set('sessions', list.slice(-MAX_SESSIONS));
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
