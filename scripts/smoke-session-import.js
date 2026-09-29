#!/usr/bin/env node
// End-to-end check of "Import conversations": builds fixture histories for
// Hermes (SQLite), Claude Code and Codex (JSONL), boots the real app pointed at
// them, drives the picker over CDP, and verifies what lands in the sidebar —
// including that noise/tool/subagent content is dropped and re-import is a no-op.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-import-'));
const fakeHome = path.join(tmp, 'home');
const userData = path.join(tmp, 'ud');
fs.mkdirSync(userData, { recursive: true });
const electron = require('electron');

// ---- fixtures ----
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const cc = path.join(fakeHome, '.claude', 'projects', '-home-x');
fs.mkdirSync(cc, { recursive: true });
fs.writeFileSync(path.join(cc, 'c1.jsonl'), jl([
  { type: 'user', isMeta: true, sessionId: 'c1', message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' } },
  { type: 'user', sessionId: 'c1', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'Fix my render settings' } },
  { type: 'assistant', sessionId: 'c1', timestamp: '2026-09-01T10:00:05Z', message: { content: [{ type: 'thinking', thinking: 'SECRET-THOUGHT' }, { type: 'tool_use', name: 'Bash', input: {} }] } },
  { type: 'user', sessionId: 'c1', message: { content: [{ type: 'tool_result', content: 'TOOL-OUTPUT' }] } },
  { type: 'assistant', sessionId: 'c1', timestamp: '2026-09-01T10:00:09Z', message: { content: [{ type: 'text', text: 'Set samples to 128.' }] } },
  { type: 'ai-title', aiTitle: 'Blender render settings', sessionId: 'c1' },
]));
const cx = path.join(fakeHome, '.codex', 'sessions', '2026', '09', '02');
fs.mkdirSync(cx, { recursive: true });
fs.writeFileSync(path.join(cx, 'rollout-2026-09-02T10-00-00-x1.jsonl'), jl([
  { type: 'session_meta', payload: { id: 'x1', source: 'cli' } },
  { type: 'response_item', timestamp: '2026-09-02T10:00:00Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEV-PROMPT' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
  { type: 'response_item', timestamp: '2026-09-02T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Plan my upload schedule' }] } },
  { type: 'response_item', timestamp: '2026-09-02T10:00:04Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tuesdays and Fridays.' }] } },
]));
fs.writeFileSync(path.join(cx, 'rollout-2026-09-02T11-00-00-x2.jsonl'), jl([
  { type: 'session_meta', payload: { id: 'x2', parent_thread_id: 'x1', source: { subagent: { other: 'guardian' } } } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SUBAGENT-TASK' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
]));
const hh = path.join(fakeHome, '.hermes');
fs.mkdirSync(hh, { recursive: true });
const mk = spawnSync(electron, ['-e', `
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(${JSON.stringify(path.join(hh, 'state.db'))});
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, started_at REAL, last_activity_at REAL, ended_at REAL, message_count INTEGER, hidden INTEGER DEFAULT 0, parent_session_id TEXT)");
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1, display_order INTEGER)");
  const s = db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,0,?)");
  s.run('h1','desktop','Channel growth ideas',1788000000,1788000100,null,4,null);
  s.run('h2','desktop','Subagent: audit',1788000000,1788000200,null,2,'h1');
  s.run('h3','cron','Nightly job',1788000000,1788000300,null,2,null);
  s.run('aria-00000000-0000-0000-0000-000000000000','api_server','ARIA own',1788000000,1788000400,null,2,null);
  const m = db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)");
  m.run('h1','user','How do I grow my channel?',1788000001);
  m.run('h1','assistant','',1788000002);
  m.run('h1','tool','TOOL-JSON',1788000003);
  m.run('h1','assistant','Post weekly shorts.',1788000004);
  for (const id of ['h2','h3','aria-00000000-0000-0000-0000-000000000000']) { m.run(id,'user','LEAK-'+id,1); m.run(id,'assistant','x',2); }
  db.close();`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
if (mk.status !== 0) { console.error(mk.stderr); process.exit(1); }

// ---- boot + drive ----
const port = 9800 + Math.floor(Math.random() * 150);
const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`,
  path.join(root, 'dist', 'main', 'index.js')], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ARIA_SMOKE: '1', ARIA_SMOKE_HOLD: '1', ARIA_SMOKE_USER_DATA: userData, ARIA_IMPORT_HOME: fakeHome,
    HERMES_HOME: hh, XDG_CONFIG_HOME: path.join(tmp, 'x'), XDG_CACHE_HOME: path.join(tmp, 'c') },
});
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let ok = false;
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) {
      try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && /index\.html/.test(x.url)); } catch (e) {}
      if (!t) await sleep(250);
    }
    if (!t) throw new Error('renderer not reachable');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
    const ev = (expr) => new Promise((r) => { const n = ++id; pend.set(n, r);
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
      .then((d) => { if (d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 500)); return d.result.result.value; });
    await sleep(1500);
    const out = await ev(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const until = async (f) => { for (let i = 0; i < 50; i++) { if (f()) return true; await wait(100); } return false; };
      document.querySelectorAll('#onboard-overlay,#settings-overlay').forEach(e => e.classList.remove('visible'));
      document.getElementById('app-shell').inert = false;
      const r = {};
      const btn = document.getElementById('import-sessions-btn');
      r.button = !!btn;
      btn.click();
      await until(() => document.querySelector('#import-dialog[open] .import-row'));
      const d = document.getElementById('import-dialog');
      r.dialogOpen = d.open;
      r.tabs = [...d.querySelectorAll('.import-sources button')].map(b => b.dataset.src);
      const rows = async (src) => {
        d.querySelector('.import-sources button[data-src="' + src + '"]').click();
        await until(() => d.querySelector('#import-count').textContent !== 'Loading…' && d.querySelector('.import-sources button[data-src="' + src + '"]').getAttribute('aria-selected') === 'true');
        await wait(150);
        return [...d.querySelectorAll('.import-row .import-row-title')].map(e => e.textContent);
      };
      r.hermesRows = await rows('hermes');
      r.codexRows = await rows('codex');
      r.claudeRows = await rows('claude-code');
      d.querySelector('#import-select-all').click();
      r.goLabel = d.querySelector('#import-go').textContent;
      d.querySelector('#import-go').click();
      await until(() => !d.open);
      r.closedAfter = !d.open;
      r.banner = document.getElementById('error-text').textContent;
      await wait(300);
      r.sidebar = [...document.querySelectorAll('#session-list .session-item')].map(i => i.querySelector('.s-title').textContent + ' | ' + i.querySelector('.s-meta').textContent);
      // Open the imported one and read the transcript.
      const item = [...document.querySelectorAll('#session-list .session-open')].find(b => /Blender/.test(b.textContent));
      item.click();
      await until(() => document.querySelectorAll('#conversation .message').length >= 2);
      r.transcript = [...document.querySelectorAll('#conversation .message')].map(m => m.className.split(' ')[1] + ': ' + [...m.childNodes].filter(n => n.nodeType === 3).map(n => n.nodeValue).join(''));
      // Re-open the picker: the imported one must be marked and disabled.
      btn.click();
      await until(() => d.open);
      r.again = await rows('claude-code');
      r.againDisabled = [...d.querySelectorAll('.import-row input')].every(c => c.disabled);
      r.againMeta = d.querySelector('.import-row-meta') && d.querySelector('.import-row-meta').textContent;
      d.close();
      return r;
    })()`);
    console.log(JSON.stringify(out, null, 2));
    const leaks = /SECRET-THOUGHT|TOOL-OUTPUT|TOOL-JSON|DEV-PROMPT|environment_context|local-command|LEAK-|SUBAGENT/;
    const checks = {
      buttonInSidebar: out.button,
      allSourcesOffered: out.tabs.join() === 'hermes,claude-code,codex',
      hermesOnlyRealChats: out.hermesRows.join() === 'Channel growth ideas',
      codexSkipsSubagents: out.codexRows.join() === 'Plan my upload schedule',
      claudeUsesAiTitle: out.claudeRows.join() === 'Blender render settings',
      importsSelected: out.goLabel === 'Import 1' && out.closedAfter && /^Imported 1 conversation\. It.s pinned/.test(out.banner),
      sidebarShowsSource: out.sidebar.some((s) => /^Blender render settings \| from Claude Code/.test(s)),
      transcriptClean: out.transcript.join('\n') === 'user: Fix my render settings\nassistant: Set samples to 128.',
      noLeaks: !leaks.test(JSON.stringify(out.transcript) + JSON.stringify(out.hermesRows) + JSON.stringify(out.codexRows)),
      reimportBlocked: out.again.length === 1 && out.againDisabled && out.againMeta === 'Already imported',
    };
    for (const [k, v] of Object.entries(checks)) console.log(`[${k}] ${v ? 'PASS' : 'FAIL'}`);
    ok = Object.values(checks).every(Boolean);
    ws.close();
  } catch (e) {
    console.error('[import] error:', e.message);
    console.error(log.split('\n').slice(-15).join('\n'));
  } finally {
    child.kill('SIGTERM'); await sleep(800); try { child.kill('SIGKILL'); } catch (e) {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(ok ? 'smoke:session-import PASS' : 'smoke:session-import FAIL');
  process.exit(ok ? 0 : 1);
})();
