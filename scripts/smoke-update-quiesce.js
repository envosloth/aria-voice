#!/usr/bin/env node
/* Regression test for update quiescing: it must stop only live sidecars and
 * restart exactly that snapshot if the updater returns instead of relaunching. */

const { Supervisor } = require('../dist/main/supervisor');

let pass = true;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) pass = false;
  console.log(`[${name}] ${JSON.stringify(got)}${ok ? ' == ' : ' != '}${JSON.stringify(want)} -> ${ok ? 'PASS' : 'FAIL'}`);
}

function state(process) {
  return {
    process,
    socket: null,
    server: null,
    restartCount: 0,
    lastHeartbeat: 0,
    circuitOpen: false,
    recovering: false,
    desiredRunning: !!process,
    circuitResetTimer: null,
    ready: false,
    readyPromise: Promise.resolve(),
    readyResolve: () => {},
    stdoutBuf: '',
  };
}

async function main() {
  const supervisor = new Supervisor(() => {});
  // The test holds the supervisor at its public lifecycle boundary; no Python
  // sidecar is needed to verify the snapshot/restore contract.
  supervisor.sidecars = new Map([
    ['wakeword', state({ pid: 1001 })],
    ['tts', state({ pid: 1002 })],
    ['stt', state(null)],
  ]);
  const stopped = [];
  const started = [];
  supervisor.killSidecar = async (name, sidecar) => {
    stopped.push(name);
    sidecar.process = null;
  };
  supervisor.start = async (name) => { started.push(name); };

  const snapshot = await supervisor.quiesceForUpdate();
  check('quiesce snapshots only running sidecars', snapshot, ['wakeword', 'tts']);
  check('quiesce stops only running sidecars', stopped, ['wakeword', 'tts']);
  check('quiesce does not permanently shut down supervisor', supervisor.shuttingDown, false);

  await supervisor.resumeAfterUpdate(snapshot);
  check('resume starts prior running sidecars only', started, ['wakeword', 'tts']);

  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
