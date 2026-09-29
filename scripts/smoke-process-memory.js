#!/usr/bin/env node
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Supervisor } = require('../dist/main/supervisor');
const child = spawn(process.execPath, ['-e', "global.data=Buffer.alloc(96*1024*1024,1);console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
(async () => {
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
  try {
    const events = [];
    const sup = new Supervisor((...e) => events.push(e));
    // Model bridge stand-in is this process; the actual owned child holds memory.
    const limit = process.memoryUsage().rss / 1048576 + 40;
    sup.rssLimitsMb.stt = limit;
    const state = { process: { pid: process.pid }, circuitOpen: false, recovering: false, restartGeneration: 1 };
    sup.sidecars.set('stt', state);
    let kills = 0;
    sup.killThenRecover = () => kills++;
    await sup.checkMemory();
    assert.equal(kills, 1, 'descendant memory must trip the STT process-tree ceiling');
    assert.equal(events[0][1], 'memory-exceeded');
    console.log('PASS real memory-heavy child trips lightweight parent watchdog');
    const memory = require('../dist/main/process-memory');
    assert.deepEqual(memory.parseProcessMemory('10 1 20\n11 10 30\n12 11 40\ninvalid'), [
      { pid: 10, parent: 1, rssKb: 20 }, { pid: 11, parent: 10, rssKb: 30 }, { pid: 12, parent: 11, rssKb: 40 },
    ]);
    assert.equal(memory.processTreeRss(memory.parseProcessMemory('10 12 20\n11 10 30\n12 11 40'), 10), 90);
    assert.equal(memory.processTreeRss([], 10), null);
    assert.deepEqual(memory.parseProcessMemory('{"ProcessId":10,"ParentProcessId":1,"WorkingSetSize":2048}', true), [{ pid: 10, parent: 1, rssKb: 2 }]);
    console.log('PASS POSIX/Windows numeric snapshots and cycle-safe descendant accounting');
    const read = memory.readProcessMemory;
    try {
      let release;
      memory.readProcessMemory = () => new Promise(r => { release = r; });
      const pending = sup.checkMemory();
      await sup.checkMemory(); // overlapping sample must be ignored
      state.restartGeneration++;
      release([{ pid: process.pid, parent: 0, rssKb: 9999999 }]);
      await pending;
      assert.equal(kills, 1, 'old measurement must not kill restarted incarnation');
      memory.readProcessMemory = async () => { throw new Error('fixture monitor unavailable'); };
      await sup.checkMemory(); await sup.checkMemory();
      assert.equal(events.filter(e => e[1] === 'warning').length, 1);
      console.log('PASS stop/restart race and one warning per outage');
    } finally { memory.readProcessMemory = read; }
  } finally { child.kill('SIGKILL'); await new Promise(r => child.once('exit', r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
