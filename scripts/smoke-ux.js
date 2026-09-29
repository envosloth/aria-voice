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
const appearance = fs.readFileSync(path.join(root, 'src', 'renderer', 'appearance.js'), 'utf8');
const copyRenderer = fs.readFileSync(path.join(root, 'scripts', 'copy-renderer.js'), 'utf8');
check('glass.shipped',
  /<script src="appearance\.js"><\/script>\s*<script src="app\.js">/.test(html) && /'appearance\.js'/.test(copyRenderer),
  'appearance.js must load before app.js and be copied into dist');
check('glass.material',
  /--glass-blur/.test(html) && /backdrop-filter: var\(--glass-filter\)/.test(html) && /\.panel::before/.test(html) &&
  /html\[data-glass="frosted"\]/.test(html) && /html\[data-glass="clear"\]/.test(html),
  'panels need the tunable glass material, rim, and three material styles');
check('glass.backgrounds',
  ['obsidian', 'studio', 'eclipse', 'aurora', 'dusk', 'ocean', 'observatory', 'solid', 'custom'].every((b) => appearance.includes(`id: '${b}'`)) &&
  /id="bg-swatches"[^>]*role="radiogroup"/.test(html),
  'every background scene must be offered as an accessible radio');
check('glass.customImage',
  /id="custom-bg-file"[^>]*accept="image\//.test(html) && /indexedDB\.open/.test(appearance) &&
  /MAX_IMAGE_BYTES/.test(appearance) && /img-src 'self' blob:/.test(html) && /id="custom-bg-clear"/.test(html),
  'a custom image must be pickable, size-checked, kept out of JSON config, and removable');
check('glass.controlsBound',
  /bind\('cfg-glass-blur', 'glassBlur'\)/.test(app) && /host\.addEventListener\('keydown'/.test(app) &&
  /addEventListener\('drop'/.test(app),
  'blur/tint/dim sliders, keyboard swatch navigation, and drag-and-drop must be wired');
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
// Endpoint/model fields belong behind a disclosure so the common path stays
// provider + key. Assert the property (each one is inside a disclosure), not a
// count — a count silently breaks the moment another provider is added, which is
// exactly what happened when the routing coordinator gained its own endpoint.
const connections = html.slice(html.indexOf('id="settings-connections"'), html.indexOf('id="settings-remote"'));
const insideDisclosure = (id) => {
  const at = connections.indexOf(`id="${id}"`);
  if (at < 0) return false;
  const open = connections.lastIndexOf('<details class="adv">', at);
  const close = connections.lastIndexOf('</details>', at);
  return open >= 0 && open > close;
};
check('settings.advancedCollapsed',
  ['cfg-llm-endpoint', 'cfg-harness-endpoint', 'cfg-jev-endpoint'].every(insideDisclosure)
    && /<details class="adv">/.test(connections),
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


// Settings → Connections → Routing brain: the coordinator selector. The two
// options must both be offered, the Jev fields must only appear when Jev is
// selected, and the choice has to survive a save/load round trip.
check('routing.coordinatorControl',
  /<select id="cfg-router-coordinator">/.test(html)
    && /<option value="builtin">/.test(html) && /<option value="jev">/.test(html),
  'both coordinators must be selectable');
check('routing.coordinatorPersisted',
  /aria\.config\.set\('routing\.coordinator'/.test(app)
    && /aria\.config\.get\('routing\.coordinator'\)/.test(app),
  'the choice must be saved and restored');
const jevKeyInput = (/<input[^>]*id="cfg-jev-key"[^>]*>/.exec(html) || [''])[0];
check('routing.jevKeyIsSecret',
  /aria\.secure\.set\('jev-api-key'/.test(app) && /type="password"/.test(jevKeyInput),
  'the Jev key belongs in the keyring, never in config');
check('routing.jevFieldsRevealed',
  /function applyCoordinatorSelection\(\)/.test(app) && /cfg\.jevBlock\.hidden = !jev/.test(app)
    && /cfg\.routerCoordinator\.addEventListener\('change', applyCoordinatorSelection\)/.test(app),
  'the Jev fields appear only when Jev is the coordinator');
check('routing.explainsTheCost',
  /about 100ms/.test(app) && /up to 1\.5s/.test(app),
  'each coordinator must say what it costs in the hint');
check('routing.statusRow',
  /id="conn-router-dot"/.test(html) && /setConnRow\('router'/.test(app),
  'the status card must report the routing brain');
console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
