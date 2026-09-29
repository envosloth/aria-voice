#!/usr/bin/env node
/* UX regression checks for the primary ARIA interaction paths. These are static
 * by design: the full Electron flow also starts sidecars, which is unsuitable
 * for verifying keyboard affordances and responsive escape hatches in isolation. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

let pass = true;
function check(name, condition, detail = '') {
  if (!condition) pass = false;
  console.log(`[${name}] ${condition ? 'PASS' : `FAIL${detail ? ` -> ${detail}` : ''}`}`);
}

check('composer.sendControl',
  /<button id="send-btn"[^>]*aria-label="Send message"/.test(html),
  'typed messages need a visible, named send control');
check('composer.sendBinding',
  /sendBtn\.addEventListener\('click', submitTextInput\)/.test(app),
  'send control must submit through the same path as Enter');
check('compact.controls',
  /id="compact-new-session-btn"/.test(html) && /id="compact-settings-btn"/.test(html),
  'settings and new-session actions disappear with the sidebar on narrow windows');
check('compact.controlBindings',
  /compactNewSessionBtn\.addEventListener\('click', startNewSession\)/.test(app) &&
  /compactSettingsBtn\.addEventListener\('click', \(\) => openSettings\(compactSettingsBtn\)\)/.test(app),
  'compact actions must be wired');
check('live.status',
  /id="aria-status"[^>]*role="status"[^>]*aria-live="polite"/.test(html),
  'voice state changes need non-visual feedback');
check('sidecar.statusText',
  /id="status-stt-label"[^>]*role="status"/.test(html) && /const statusLabels/.test(app) &&
  /statusLabel\.textContent/.test(app) && /dot\.title =/.test(app),
  'sidecar health needs announced text as well as a colored dot');
check('mic.keyboardAndState',
  /micBtn\.addEventListener\('keydown',/.test(app) &&
  /micBtn\.addEventListener\('keyup',/.test(app) &&
  /micBtn\.setAttribute\('aria-pressed', 'true'\)/.test(app) &&
  /micBtn\.setAttribute\('aria-pressed', 'false'\)/.test(app),
  'hold-to-talk must work and report state from the keyboard');
check('error.dismissible',
  /id="error-dismiss"/.test(html) && /errorDismiss\.addEventListener\('click', clearError\)/.test(app),
  'actionable failures must remain readable until dismissed');
check('onboarding.progress',
  /id="onb-progress"[^>]*aria-live="polite"/.test(html) &&
  /onb\.progress\.textContent\s*=/.test(app),
  'multi-step setup needs explicit progress, not dots alone');
check('onboarding.singleScreen',
  (html.match(/class="onboard-step"/g) || []).length === 1 && /const ONB_LAST = 0;/.test(app) &&
  !/id="onb-mic"/.test(html) && /Skip for now/.test(html),
  'first-run setup must be one screen; the mic starts on its own, not via a setup step');
check('onboarding.autoConnectsLocalHarness',
  /async function onbAutoConnect\(/.test(app) && /await onbAutoConnect\(\)/.test(app) && /id="setup-toast"/.test(html),
  'a local Hermes/OpenClaw gateway with a readable key must connect with zero questions');
check('onboarding.keyNotStoredByTest',
  !/onb\.llmTest\.addEventListener[\s\S]{0,400}aria\.secure\.set/.test(app),
  'testing a connection must not persist the key before the user presses Start');
check('onboarding.keyringFlag',
  /password-store', 'gnome-libsecret'/.test(fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8')),
  'Linux desktops without a GNOME/KDE session must still select the Secret Service backend');
check('settings.plainLanguage',
  /id="conn-summary"/.test(html) && /function refreshConnectionSummary\(/.test(app) &&
  !/Conversational LLM|Agent harness <span|>Discover</.test(html.slice(html.indexOf('id="settings-connections"'), html.indexOf('id="settings-remote"'))),
  'Connections must lead with a live status card and use plain names (Chat model / Agent), not LLM/harness jargon');
check('settings.advancedCollapsed',
  (html.slice(html.indexOf('id="settings-connections"'), html.indexOf('id="settings-remote"')).match(/<details class="adv">/g) || []).length === 2,
  'endpoint/model fields belong behind a disclosure so the common path is provider + key');
check('settings.tabSemantics',
  /role="tablist"/.test(html) && /role="tab"/.test(html) && /setAttribute\('aria-selected'/.test(app),
  'settings navigation needs tab semantics');
check('modal.dialogSemantics',
  /class="settings-panel" role="dialog" aria-modal="true"/.test(html) &&
  /class="onboard-panel" role="dialog" aria-modal="true"/.test(html),
  'settings and onboarding need announced modal semantics');
check('modal.focusManagement',
  /function trapModalFocus\(/.test(app) && /settingsReturnFocus/.test(app) && /onboardingReturnFocus/.test(app) && /appShell\.inert\s*=/.test(app),
  'modal surfaces must retain and restore keyboard focus');
check('modal.initialFocusFallback',
  /element !== document\.body/.test(app),
  'first-run onboarding must return focus to the text input, not the document body');
check('setup.connectionCta',
  /id="setup-connection-btn"/.test(html) && /function setSetupNeeded\(/.test(app) &&
  /ui\.setup-needed/.test(app) && /openSettings\(setupConnectionButton\)/.test(app),
  'unconfigured installs need a visible path to connection settings');
check('sessionMenu.keyboardFlow',
  /menuBtn\.setAttribute\('aria-controls', menu\.id\)/.test(app) &&
  /menu\.querySelector\('\[role="menuitem"\]'\)\.focus\(\)/.test(app) &&
  /menu\.addEventListener\('keydown'/.test(app) && /btn\.focus\(\)/.test(app),
  'session overflow menus need keyboard navigation and focus return');

// Push-to-talk release handlers must only end a PTT turn: a hands-free (wake
// word / VAD) turn must not be cut off when the pointer leaves the mic button,
// the button blurs, or an unrelated key-up reaches it.
{
  const pttBlock = app.slice(app.indexOf('let pttActive'), app.indexOf('// Start capturing as soon as'));
  check('ptt.flagGatesRelease',
    /let pttActive = false/.test(app) &&
    /function endPushToTalk\(\)\s*\{\s*if \(!pttActive\) return;/.test(pttBlock) &&
    /micBtn\.addEventListener\('mouseup', endPushToTalk\)/.test(pttBlock) &&
    /micBtn\.addEventListener\('mouseleave', endPushToTalk\)/.test(pttBlock) &&
    /micBtn\.addEventListener\('blur', endPushToTalk\)/.test(pttBlock) &&
    !/addEventListener\('(?:mouseup|mouseleave|blur)', endUtterance\)/.test(app),
    'PTT release must not end hands-free VAD turns');
  check('ptt.flagSetOnPress',
    /function startPushToTalk\(\)[\s\S]{0,300}beginUtterance\(\{ ptt: true \}\)/.test(pttBlock) && /if \(opts && opts.ptt\) pttActive = true/.test(app) &&
    /micBtn\.addEventListener\('mousedown', startPushToTalk\)/.test(pttBlock),
    'mousedown/keydown must mark the turn as push-to-talk');
}

// A voice "share my screen" whose getDisplayMedia fails must not leave the orb
// stuck in 'processing' (submitUserMessage returns before LLM dispatch).
{
  const start = app.slice(app.indexOf('async function startScreenShare'), app.indexOf('function stopScreenShare'));
  const failBranch = start.slice(start.indexOf('} catch (err)'));
  check('screenshare.failureReturnsOrbIdle',
    /orbState\('idle'\)/.test(failBranch),
    'failed screen share must return the orb to idle');
}

// TTS epoch: main is authoritative; the renderer seeds from it at startup and
// adopts main's epoch from every stop, so a renderer reload cannot desync.
check('tts.epochSeededFromMain',
  /aria\.tts\.epoch\(\)/.test(app) && /aria\.tts\.stop\([^)]*\)\s*\.then\(/.test(app),
  'renderer must seed and resync its TTS epoch from main');

// Plain-language activity: one strip that always says what ARIA is doing and
// what the user can do next, plus a Stop control while it is busy.
check('activity.strip',
  /id="activity-strip"[^>]*data-phase=/.test(html) && /id="activity-title"/.test(html) && /id="activity-detail"/.test(html),
  'a visible strip must name the current phase and next action');
check('activity.stopControl',
  /id="activity-stop"[^>]*aria-label="Stop/.test(html) && /activityStop\.addEventListener\('click', stopEverything\)/.test(app),
  'user needs a visible Stop while ARIA thinks or speaks');
check('activity.driver',
  /function refreshActivity\(/.test(app) && /function orbState\(s\)[\s\S]{0,400}refreshActivity\(\)/.test(app) &&
  /aria\.llm\.onRoute[\s\S]{0,500}refreshActivity\(\)/.test(app) && /aria\.llm\.onTool[\s\S]{0,300}refreshActivity\(\)/.test(app),
  'phase, route and tool changes must repaint the strip');
{
  const onStatus = (app.match(/function applySidecarStatus\([\s\S]*?\n\}\n/) || [''])[0];
  check('activity.sidecarAndSetup',
    /function setSetupNeeded[\s\S]{0,900}refreshActivity\(\)/.test(app) && onStatus.includes('refreshActivity()'),
    'setup and sidecar health must be reflected in the strip');
}
check('empty.state',
  /id="empty-state"/.test(html) && /#conversation:empty ~ #empty-state/.test(html) && /id="empty-hint-wake"/.test(html),
  'first-run screen must explain how to talk to ARIA');
check('empty.setupButtonInside',
  /id="empty-state"[\s\S]*id="setup-connection-btn"/.test(html),
  'connection CTA belongs inside the empty state, not overlapping text');
check('sidebar.plainLabels',
  /System status/.test(html) && /id="status-stt-text"/.test(html) && /id="status-tts-text"/.test(html) && /id="status-wakeword-text"/.test(html) &&
  !/>ENDPOINTS</.test(html),
  'sidecar rows need words (Ready/Starting/Offline), not just a dot');
check('sidebar.statusWords',
  /statusText\.textContent/.test(app),
  'sidecar status text must be updated');
check('banner.warnLevel',
  /function showError\(msg, level\)/.test(app) && /error-banner\.warn|\.error-banner\.warn/.test(html) && !/Security warning: secret storage/.test(app),
  'non-fatal notices must not look like failures and must use plain wording');
check('composer.placeholder',
  /placeholder="Type a message, or hold the mic to talk"/.test(html),
  'composer must advertise both input methods');
check('header.singleBadge',
  /\.chat-head \.state-badge \{ display: none/.test(html),
  'the state must not be shown twice on wide layouts');

check('sidecar.snapshotReplay',
  /SIDECAR_SNAPSHOT/.test(fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8')) &&
  /aria\.sidecar\.snapshot\(\)/.test(app) && /snapshot: \(\)/.test(fs.readFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'utf8')),
  'sidebar must recover sidecar status emitted before the renderer subscribed');

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
