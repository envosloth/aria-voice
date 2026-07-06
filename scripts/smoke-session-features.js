#!/usr/bin/env node
/* Static smoke coverage for the saved-session overflow menu, harness-session
 * delete propagation, and the end-of-listening chime. These are mostly renderer
 * + IPC wiring, so string-level checks catch accidental regressions without
 * needing a full Electron boot for every UI affordance.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const files = {
  ipc: read('src/shared/ipc-channels.ts'),
  preload: read('src/preload/index.ts'),
  sessions: read('src/main/sessions.ts'),
  coordinator: read('src/main/coordinator.ts'),
  app: read('src/renderer/app.js'),
  html: read('src/renderer/index.html'),
  supervisor: read('src/main/supervisor.ts'),
  baseSidecar: read('sidecars/shared/base_sidecar.py'),
  wakeReq: read('sidecars/wakeword/requirements.txt'),
  pack: read('scripts/package-sidecar.sh'),
};

let pass = true;
function check(name, cond, detail = '') {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
}

check('pin-ipc-channel', files.ipc.includes('SESSIONS_PIN'));
check('pin-preload-api', /pin:\s*\(id:\s*string,\s*pinned:\s*boolean\)/.test(files.preload));
check('session-pin-field', files.sessions.includes('pinned?: boolean') && files.sessions.includes('setSessionPinned'));
check('session-harness-field', files.sessions.includes('harnessSessionId') && files.sessions.includes('setCurrentHarnessSession'));
check('harness-delete-api', files.coordinator.includes('deletePersistedSession') && files.coordinator.includes('/api/sessions/') && files.coordinator.includes("method: 'DELETE'"));
check('renderer-menu-button', files.app.includes('session-menu-btn') && files.app.includes('aria-haspopup'));
check('renderer-menu-actions', files.app.includes('aria.sessions.pin') && files.app.includes('Delete locally + agent'));
check('renderer-delete-warning', files.app.includes('agent harness session was not deleted'));
check('session-menu-css', files.html.includes('.session-menu-btn') && files.html.includes('.session-menu button.danger'));
check('done-listening-chime', files.app.includes('playDoneListeningChime') && files.app.includes('setTimeout(playDoneListeningChime'));
check('wakeword-windows-tcp-ipc', files.supervisor.includes("process.platform === 'win32'") && files.supervisor.includes('tcp://127.0.0.1') && files.baseSidecar.includes('socket_path.startswith("tcp://")') && files.baseSidecar.includes('socket.AF_INET'));
check('wakeword-windows-onnxruntime', files.wakeReq.includes('onnxruntime') && files.pack.includes('--collect-binaries onnxruntime'));

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
