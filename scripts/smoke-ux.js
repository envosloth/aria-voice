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

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
