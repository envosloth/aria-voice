#!/usr/bin/env node
/* IPC / window hardening regression checks.
 *  1. Pure policy helpers (dist/shared/constants): LLM_SEND payload validation,
 *     secure-store key allowlist, trusted renderer URL.
 *  2. Static wiring in src/main/index.ts: every ipcMain registration goes through
 *     the sender-checked wrappers; navigation/popup/webview guards; CONFIG_SET
 *     validation; coordinate() rejection handling; STT death -> stt_failed.
 *  3. Headless Electron: TTS epoch survives a renderer reload, navigation and
 *     window.open are refused, disallowed secure keys / config values reject.
 * Requires `npm run build` first. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const C = require('../dist/shared/constants');

let pass = true;
function check(name, ok, detail = '') {
  if (!ok) pass = false;
  console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
}

// --- 1. pure helpers ---------------------------------------------------------
const jpeg = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');
const ok = C.parseLlmSendPayload({ message: 'hi', image: jpeg, turnId: 't-1', generationId: 3 });
check('llm-send-valid', ok && ok.message === 'hi' && ok.image === jpeg && ok.turnId === 't-1' && ok.generationId === 3);
check('llm-send-null-image', C.parseLlmSendPayload({ message: 'hi', image: null, turnId: 't', generationId: 1 })?.image === null);
check('llm-send-rejects-string-payload', C.parseLlmSendPayload('hi') === null);
check('llm-send-rejects-null', C.parseLlmSendPayload(null) === null);
check('llm-send-rejects-empty-turn', C.parseLlmSendPayload({ message: 'hi', turnId: '' }) === null);
check('llm-send-rejects-nonstring-message', C.parseLlmSendPayload({ message: { x: 1 }, turnId: 't' }) === null);
check('llm-send-rejects-oversize-message',
  C.parseLlmSendPayload({ message: 'x'.repeat(C.LLM_MESSAGE_MAX_CHARS + 1), turnId: 't' }) === null);
check('llm-send-accepts-max-message',
  C.parseLlmSendPayload({ message: 'x'.repeat(C.LLM_MESSAGE_MAX_CHARS), turnId: 't' }) !== null);
check('llm-send-rejects-png-image', C.parseLlmSendPayload({ message: 'hi', turnId: 't', image: 'data:image/png;base64,AAAA' }) === null);
check('llm-send-rejects-url-image', C.parseLlmSendPayload({ message: 'hi', turnId: 't', image: 'https://evil/x.jpg' }) === null);
check('llm-send-rejects-oversize-image', C.parseLlmSendPayload({
  message: 'hi', turnId: 't', image: 'data:image/jpeg;base64,' + 'A'.repeat(C.LLM_IMAGE_MAX_CHARS),
}) === null);

// An oversized paste must settle the turn with a correlated LLM_ERROR, not
// hang the renderer in 'processing' (fire-and-forget IPC has no other reply).
{
  const v = C.validateLlmSendPayload({ message: 'x'.repeat(C.LLM_MESSAGE_MAX_CHARS + 1), turnId: 't-big', generationId: 7 });
  check('llm-send-oversize-keeps-correlation',
    v.request === null && v.correlation?.turnId === 't-big' && v.correlation?.generationId === 7 && /too long/i.test(v.error || ''));
  const bad = C.validateLlmSendPayload({ message: 'hi', turnId: 't-img', generationId: 2, image: 'data:image/png;base64,AAAA' });
  check('llm-send-bad-image-keeps-correlation', bad.request === null && bad.correlation?.turnId === 't-img' && !!bad.error);
  check('llm-send-no-turn-no-correlation', !C.validateLlmSendPayload({ message: 'hi' }).correlation);
  const idx = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const sendBlock = idx.slice(idx.indexOf('on(IPC.LLM_SEND'), idx.indexOf('on(IPC.LLM_SEND') + 1400);
  check('llm-send-rejection-emits-llm-error', /validateLlmSendPayload/.test(sendBlock) && /IPC\.LLM_ERROR/.test(sendBlock.split('return;')[0]));
}
check('secret-key-llm', C.isRendererSecretKey('llm-api-key'));
check('secret-key-harness', C.isRendererSecretKey('harness-api-key'));
check('secret-key-other-refused', !C.isRendererSecretKey('ssh-key') && !C.isRendererSecretKey('') && !C.isRendererSecretKey(null));
// Every key the renderer actually uses must be allowlisted.
const appSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const usedKeys = [...appSrc.matchAll(/aria\.secure\.(?:get|set|delete)\('([^']+)'/g)].map((m) => m[1]);
check('secret-keys-cover-renderer', usedKeys.length > 0 && usedKeys.every((k) => C.isRendererSecretKey(k)),
  [...new Set(usedKeys)].join(','));

const idx = path.join(root, 'dist', 'renderer', 'index.html');
const idxUrl = require('url').pathToFileURL(idx).href;
check('trusted-url-exact', C.isTrustedRendererUrl(idxUrl, idx));
check('trusted-url-hash', C.isTrustedRendererUrl(idxUrl + '#x', idx));
check('trusted-url-other-file', !C.isTrustedRendererUrl(require('url').pathToFileURL(path.join(root, 'index.html')).href, idx));
check('trusted-url-https', !C.isTrustedRendererUrl('https://example.com/', idx));
check('trusted-url-about-blank', !C.isTrustedRendererUrl('about:blank', idx));
check('trusted-url-file-host', !C.isTrustedRendererUrl(idxUrl.replace('file://', 'file://evil'), idx));

// --- 2. static wiring --------------------------------------------------------
const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
const rawRegs = [...main.matchAll(/ipcMain\.(handle|on|once|handleOnce)\(/g)].length;
check('ipc-all-through-wrappers', rawRegs === 2, `${rawRegs} raw ipcMain registrations (expect the 2 wrappers)`);
check('ipc-wrappers-assert-sender',
  /function handle\([\s\S]{0,200}assertTrustedSender\(event, channel\)/.test(main) &&
  /function on\([\s\S]{0,200}assertTrustedSender\(event, channel\)/.test(main));
check('ipc-sender-top-frame-and-url',
  /frame\.parent !== null/.test(main) && /isTrustedRendererUrl\(frame\.url, RENDERER_INDEX\)/.test(main));
check('nav-guards',
  /web-contents-created/.test(main) && /will-navigate/.test(main) && /will-attach-webview/.test(main) &&
  /setWindowOpenHandler\([\s\S]{0,120}action: 'deny'/.test(main));
check('config-set-validated', /validateConfigSet\(key, rawValue\)/.test(main));
check('secure-store-allowlisted', (main.match(/isRendererSecretKey\(key\)/g) || []).length === 3);
check('llm-send-validated', /validateLlmSendPayload\(payload\)/.test(main));
check('coordinate-rejection-reported', /coordinate\([\s\S]{0,600}\)\.catch\([\s\S]{0,300}IPC\.LLM_ERROR/.test(main) && !/void coordinate\(/.test(main));
check('stt-death-fails-turn',
  /name === 'stt'\) failSttTurnOnSidecarDeath\(status/.test(main) &&
  /STT_DEATH_STATUSES = new Set\(\['exited', 'heartbeat-timeout', 'memory-exceeded', 'circuit-open', 'error'\]\)/.test(main) &&
  /function failSttTurnOnSidecarDeath[\s\S]{0,400}sttGate\.failStart\(turnId\)[\s\S]{0,200}state: 'stt_failed'/.test(main));
check('tts-epoch-channel', /handle\(IPC\.TTS_EPOCH, \(\) => ttsEpoch\)/.test(main) && /return ttsEpoch;/.test(main));

// --- 3. headless Electron ----------------------------------------------------
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-hardening-'));
let out = null;
try {
  const child = spawnSync(require('electron'), ['--no-sandbox', `--user-data-dir=${userData}`, path.join(root, 'dist', 'main', 'index.js')], {
    cwd: root,
    env: {
      ...process.env, ARIA_SMOKE: '1', ARIA_SMOKE_USER_DATA: userData, ARIA_VERIFY_HARDENING: '1',
      XDG_CONFIG_HOME: path.join(userData, 'xdg'), XDG_CACHE_HOME: path.join(userData, 'cache'),
    },
    encoding: 'utf8', timeout: 45000,
  });
  const text = `${child.stdout || ''}\n${child.stderr || ''}`;
  const m = text.match(/\[ARIA_VERIFY\] hardening=(.*)/);
  if (m) out = JSON.parse(m[1]);
  if (!out || process.env.VERBOSE) console.log(text.slice(-4000));
} finally {
  fs.rmSync(userData, { recursive: true, force: true });
}
check('electron-ran', !!out && !out.error, out ? JSON.stringify(out) : 'no verify output');
if (out) {
  check('tts-epoch-main-advanced', out.mainEpochBeforeReload >= 3, `main=${out.mainEpochBeforeReload}`);
  const plays = out.ttsPlays || [];
  check('tts-play-after-reload-accepted', plays.length >= 2 && plays.every((p) => p.accepted),
    JSON.stringify(plays));
  check('tts-play-epoch-beyond-pre-reload', plays.length > 0 && plays[0].epoch > out.mainEpochAfterReload,
    `first play epoch ${plays[0] && plays[0].epoch}, main before ${out.mainEpochAfterReload}`);
  check('stt-turn-survives-benign-status', out.sttSurvivesLog === true);
  check('stt-turn-failed-on-sidecar-death', out.sttFailedOnDeath === true);
  check('window-open-denied', out.windowOpen === 'null', out.windowOpen);
  check('navigation-blocked', typeof out.urlAfterNavigate === 'string' && out.urlAfterNavigate.startsWith('file:') &&
    out.urlAfterNavigate.includes('index.html'), out.urlAfterNavigate);
  check('secure-bad-key-rejected', out.secureBadKey === 'rejected');
  check('secure-good-key-allowed', out.secureGoodKey === 'allowed');
  check('config-bad-value-rejected', out.configBad === 'rejected');
  check('config-good-value-allowed', out.configGood === 'allowed');
}

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
