// Import past conversations from the user's agent harness into ARIA's session
// list, so switching to ARIA doesn't mean starting from zero.
//
// Read-only on every source. Only plain user/assistant text is imported: tool
// calls, tool output, reasoning, system/developer prompts and CLI meta lines are
// dropped. Imported records never carry a harnessSessionId, so deleting one in
// ARIA can never delete the original in the harness.
//
// Sources:
//   hermes      — $HERMES_HOME/state.db (or ~/.hermes/state.db), SQLite
//   claude-code — ~/.claude/projects/*/*.jsonl
//   codex       — ~/.codex/sessions/**/rollout-*.jsonl
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionTurn } from './sessions';

export type ImportSourceId = 'hermes' | 'claude-code' | 'codex';
export const IMPORT_SOURCES: Record<ImportSourceId, string> = {
  hermes: 'Hermes Agent',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export interface ImportCandidate {
  source: ImportSourceId;
  externalId: string;
  title: string;
  updatedAt: number;
  turns: number;
}
export interface ImportedConversation extends ImportCandidate {
  startedAt: number;
  turnList: SessionTurn[];
}
export interface ImportSourceInfo { id: ImportSourceId; name: string; available: boolean; }

const MAX_CANDIDATES = 60;        // newest N per source shown in the picker
const MAX_TURNS = 200;            // matches sessions.MAX_TURNS_PER_SESSION
const MAX_TURN_CHARS = 8000;      // one pasted log must not bloat the store
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const TITLE_MAX = 60;

function home(): string { return process.env.ARIA_IMPORT_HOME || os.homedir(); }
function hermesDb(): string {
  const h = (process.env.HERMES_HOME || '').trim();
  const base = h ? h.replace(/^~(?=$|\/)/, home()) : path.join(home(), '.hermes');
  return path.join(base, 'state.db');
}
const claudeRoot = () => path.join(home(), '.claude', 'projects');
const codexRoot = () => path.join(home(), '.codex', 'sessions');

function exists(p: string): boolean { try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; } }

export function listSources(): ImportSourceInfo[] {
  return (Object.keys(IMPORT_SOURCES) as ImportSourceId[]).map((id) => ({
    id,
    name: IMPORT_SOURCES[id],
    available: id === 'hermes' ? exists(hermesDb()) : id === 'claude-code' ? exists(claudeRoot()) : exists(codexRoot()),
  }));
}

// ---- text helpers ---------------------------------------------------------
function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_TURN_CHARS ? t.slice(0, MAX_TURN_CHARS - 1) + '…' : t;
}
function mkTitle(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + '…' : t;
}
// CLI/harness scaffolding that is not something the user actually said.
const NOISE = /^\s*<(local-command-[\w-]+|command-[\w-]+|system-reminder|environment_context|user_instructions|permissions instructions|turn_aborted|subagent_notification)\b/i;
function isNoise(text: string): boolean { return !text.trim() || NOISE.test(text); }

// Merge consecutive same-role turns (agents emit one assistant record per text
// block) and cap the total.
function normalise(raw: SessionTurn[]): SessionTurn[] {
  const out: SessionTurn[] = [];
  for (const t of raw) {
    const content = clip(t.content);
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) {
      prev.content = clip(prev.content + '\n\n' + content);
      prev.ts = t.ts || prev.ts;
    } else out.push({ role: t.role, content, ts: t.ts });
  }
  return out.length > MAX_TURNS ? out.slice(-MAX_TURNS) : out;
}
function toMs(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : v;
  const n = Date.parse(String(v || ''));
  return Number.isFinite(n) ? n : 0;
}

function readLines(file: string): string[] {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return [];
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch { return []; }
}
function parse(line: string): Record<string, unknown> | null {
  if (!line) return null;
  try { const v = JSON.parse(line); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
function newestFiles(files: string[], n: number): string[] {
  return files
    .map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter((x): x is { f: string; m: number } => !!x)
    .sort((a, b) => b.m - a.m)
    .slice(0, n)
    .map((x) => x.f);
}
function walk(dir: string, match: (name: string) => boolean, depth = 4): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...walk(p, match, depth - 1));
    else if (e.isFile() && match(e.name)) out.push(p);
  }
  return out;
}

// ---- Claude Code ----------------------------------------------------------
function textParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && typeof c === 'object' && (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text'))
    .map((c) => String(c.text || ''))
    .join('\n');
}
function readClaude(file: string): ImportedConversation | null {
  const turns: SessionTurn[] = [];
  let title = '';
  let id = path.basename(file, '.jsonl');
  for (const line of readLines(file)) {
    const d = parse(line);
    if (!d) continue;
    if (d.type === 'ai-title' && typeof d.aiTitle === 'string') title = d.aiTitle;
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    if (d.isMeta || d.isSidechain) continue;
    if (typeof d.sessionId === 'string') id = d.sessionId;
    const msg = (d.message || {}) as { content?: unknown };
    const text = textParts(msg.content);
    if (isNoise(text)) continue;
    turns.push({ role: d.type as 'user' | 'assistant', content: text, ts: toMs(d.timestamp) });
  }
  return finish('claude-code', id, title, turns);
}

// ---- Codex ----------------------------------------------------------------
function readCodex(file: string): ImportedConversation | null {
  const turns: SessionTurn[] = [];
  let id = path.basename(file, '.jsonl').replace(/^rollout-[\dT-]+-/, '');
  for (const line of readLines(file)) {
    const d = parse(line);
    if (!d) continue;
    const p = (d.payload || {}) as Record<string, unknown>;
    if (d.type === 'session_meta') {
      if (typeof p.id === 'string') id = p.id;
      // Internal sub-agents (guardian, reviewers, …) are not the user's chats.
      if (p.parent_thread_id || (p.source && typeof p.source === 'object')) return null;
    }
    if (d.type !== 'response_item' || p.type !== 'message') continue;
    if (p.role !== 'user' && p.role !== 'assistant') continue;
    const text = textParts(p.content);
    if (isNoise(text)) continue;
    turns.push({ role: p.role as 'user' | 'assistant', content: text, ts: toMs(d.timestamp) });
  }
  return finish('codex', id, '', turns);
}

// ---- Hermes ---------------------------------------------------------------
type Db = { prepare(sql: string): { all(...a: unknown[]): Record<string, unknown>[] }; close(): void };
function openHermes(): Db | null {
  if (!exists(hermesDb())) return null;
  try {
    // node:sqlite ships with Electron's Node (22.5+); loaded lazily so a
    // runtime without it simply reports Hermes as unavailable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(hermesDb(), { readOnly: true }) as Db;
  } catch { return null; }
}
function hermesTurns(db: Db, id: string): SessionTurn[] {
  return db.prepare(
    `SELECT role, content, timestamp FROM messages
     WHERE session_id = ? AND role IN ('user','assistant') AND COALESCE(active,1) = 1
       AND content IS NOT NULL AND TRIM(content) <> ''
     ORDER BY COALESCE(display_order, id)`,
  ).all(id).map((r) => ({ role: r.role as 'user' | 'assistant', content: String(r.content), ts: toMs(r.timestamp) }))
    .filter((t) => !isNoise(t.content));
}
// Conversations a person had (not cron jobs or subagent runs).
const HERMES_SOURCES = "('cli','desktop','tui','webui','telegram','api_server','discord','slack','signal','whatsapp')";
function hermesSessionRows(db: Db, ids?: string[]): Record<string, unknown>[] {
  const base = `SELECT id, title, started_at, COALESCE(last_activity_at, ended_at, started_at) AS updated
    FROM sessions WHERE source IN ${HERMES_SOURCES} AND COALESCE(hidden,0) = 0 AND message_count > 0
      AND parent_session_id IS NULL AND COALESCE(title,'') NOT LIKE 'Subagent:%'`;
  if (ids && ids.length) {
    return db.prepare(`${base} AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  }
  return db.prepare(`${base} ORDER BY updated DESC LIMIT ${MAX_CANDIDATES * 2}`).all();
}
// ARIA's own turns reach Hermes as 'aria-<uuid>' sessions; re-importing them
// would duplicate conversations ARIA already has.
const isAriaOwn = (id: string) => /^aria-[0-9a-f-]{36}$/i.test(id);

function readHermes(ids?: string[]): ImportedConversation[] {
  const db = openHermes();
  if (!db) return [];
  try {
    const out: ImportedConversation[] = [];
    for (const r of hermesSessionRows(db, ids)) {
      const id = String(r.id);
      if (isAriaOwn(id)) continue;
      const conv = finish('hermes', id, String(r.title || ''), hermesTurns(db, id), toMs(r.started_at), toMs(r.updated));
      if (conv) out.push(conv);
      if (!ids && out.length >= MAX_CANDIDATES) break;
    }
    return out;
  } finally { try { db.close(); } catch { /* read-only */ } }
}

// ---- shared ---------------------------------------------------------------
function finish(source: ImportSourceId, externalId: string, title: string, raw: SessionTurn[],
  startedAt?: number, updatedAt?: number): ImportedConversation | null {
  const turnList = normalise(raw);
  // A conversation needs at least one thing the user said and one reply.
  if (!turnList.some((t) => t.role === 'user') || !turnList.some((t) => t.role === 'assistant')) return null;
  const firstUser = turnList.find((t) => t.role === 'user');
  const stamps = turnList.map((t) => t.ts).filter((n) => n > 0);
  return {
    source,
    externalId,
    title: mkTitle(title || (firstUser ? firstUser.content : '') || 'Imported conversation'),
    startedAt: startedAt || (stamps.length ? Math.min(...stamps) : Date.now()),
    updatedAt: updatedAt || (stamps.length ? Math.max(...stamps) : Date.now()),
    turns: turnList.length,
    turnList,
  };
}

function readAll(source: ImportSourceId, ids?: string[]): ImportedConversation[] {
  const want = ids && ids.length ? new Set(ids) : null;
  if (source === 'hermes') return readHermes(ids);
  const files = source === 'claude-code'
    ? walk(claudeRoot(), (n) => n.endsWith('.jsonl'), 1)
    : walk(codexRoot(), (n) => /^rollout-.*\.jsonl$/.test(n), 4);
  const reader = source === 'claude-code' ? readClaude : readCodex;
  const out: ImportedConversation[] = [];
  for (const f of want ? files : newestFiles(files, MAX_CANDIDATES * 2)) {
    const conv = reader(f);
    if (!conv) continue;
    if (want && !want.has(conv.externalId)) continue;
    out.push(conv);
    if (!want && out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export function listCandidates(source: ImportSourceId): ImportCandidate[] {
  return readAll(source)
    .map(({ turnList: _t, startedAt: _s, ...c }) => c)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadConversations(source: ImportSourceId, ids: string[]): ImportedConversation[] {
  return readAll(source, ids);
}

export function isImportSource(v: unknown): v is ImportSourceId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(IMPORT_SOURCES, v);
}
