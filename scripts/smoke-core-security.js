#!/usr/bin/env node
/* Narrow core regression coverage for endpoint credential transport, secure
 * storage policy, and session-retention ordering. This deliberately avoids the
 * renderer and runs as plain Node after TypeScript compilation. */
const { credentialedEndpointSecurityError } = require('../dist/main/endpoint-security');
const { isSecureBackendNameSafe } = require('../dist/main/secure-storage');
const { retainSessions } = require('../dist/main/sessions');
const fs = require('fs');
const path = require('path');

let pass = true;
function check(name, ok, detail = '') {
  if (!ok) pass = false;
  console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`);
}

check('http-loopback-credentials-allowed', credentialedEndpointSecurityError(new URL('http://127.0.0.1:8642/v1'), true) === null);
check('http-ipv6-loopback-credentials-allowed', credentialedEndpointSecurityError(new URL('http://[::1]:8642/v1'), true) === null);
check('https-remote-credentials-allowed', credentialedEndpointSecurityError(new URL('https://api.example.com/v1'), true) === null);
check('http-remote-credentials-refused', /HTTPS/.test(credentialedEndpointSecurityError(new URL('http://api.example.com/v1'), true) || ''));
check('http-remote-without-credentials-allowed', credentialedEndpointSecurityError(new URL('http://api.example.com/v1'), false) === null);

check('basic-text-is-insecure', isSecureBackendNameSafe('basic_text') === false);
check('unavailable-is-insecure', isSecureBackendNameSafe('unavailable') === false);
check('keychain-is-secure', isSecureBackendNameSafe('keychain') === true);

const source = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', file), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
check('safe-storage-refuses-basic-text-write', /function setSecret[\s\S]*?requireSecureBackend\(\)/.test(source('secure-storage.ts')));
check('chat-applies-credential-https-guard', source('llm-stream.ts').includes('credentialedEndpointSecurityError'));
check('model-discovery-applies-credential-https-guard', source('llm-models.ts').includes('credentialedEndpointSecurityError'));
check('session-delete-applies-credential-https-guard', source('coordinator.ts').includes('credentialedEndpointSecurityError'));
const settingsSave = rendererSource.slice(rendererSource.indexOf("settingsSave.addEventListener"), rendererSource.indexOf('// --- First-run onboarding'));
check('settings-save-persists-secrets-before-config', settingsSave.indexOf('aria.secure.set') < settingsSave.indexOf("aria.config.set('routing.mode'"));
check('settings-save-surfaces-secure-storage-failure', /catch\s*\([^)]+\)[\s\S]*?savedMsg\.textContent\s*=\s*['`]Save failed/.test(settingsSave));

const make = (id, updatedAt, pinned = false) => ({
  id, title: id, startedAt: updatedAt, updatedAt, turns: [], pinned,
});
const records = [make('old-pinned', 1, true)];
for (let i = 0; i < 55; i++) records.push(make(`session-${i}`, i + 2));
const kept = retainSessions(records);
check('retention-keeps-pinned', kept.some((session) => session.id === 'old-pinned'));
check('retention-caps-unpinned-not-pinned', kept.length === 51, `kept ${kept.length}`);
check('retention-keeps-fifty-unpinned-plus-pins', kept.filter((session) => !session.pinned).length === 50);
check('retention-orders-by-updated-at', kept.every((session, index) => index === 0 || kept[index - 1].updatedAt >= session.updatedAt));
check('retention-drops-oldest-unpinned', !kept.some((session) => session.id === 'session-0'));

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
