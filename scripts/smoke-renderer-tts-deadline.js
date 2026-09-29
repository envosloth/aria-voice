#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const A = require('../src/renderer/audio-utils.js');
const src = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '../src/renderer/app.js'), 'utf8');
const start = src.indexOf("let ttsStreamBuf = '';");
const end = src.indexOf('// A tool the harness invoked', start);
assert.ok(start > 0 && end > start);
let now = 0, id = 0; const timers = new Map(); const spoken = [];
const c = vm.createContext({ window: { AriaAudio: A }, performance: { now: () => now },
  setTimeout: (f, ms) => { timers.set(++id,{f,at:now+ms}); return id; }, clearTimeout: n=>timers.delete(n),
  fillerSpeaking:false,ttsSynthDone:false,idleTimer:null,ttsFirstRequestMarked:false,currentTurnId:'turn',currentReplyId:'old',
  perf:{mark(){}},stopPlayback(){},enterSpeech(){},ttsPlay:(text,replyId)=>spoken.push({text,replyId}),
});
vm.runInContext(src.slice(start,end),c);
const run = s=>vm.runInContext(s,c);
const tick = ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.f();}};
run("feedTtsStream('A healthy daily routine provides lasting benefits ')");
assert.strictEqual(spoken.length,0);
tick(250);
assert.strictEqual(spoken.length,1,'stalled stream must synthesize without another token');
assert.strictEqual(spoken[0].text,'A healthy daily routine provides lasting benefits');
run("resetTtsStream();feedTtsStream('An obsolete reply must never cross turns ');resetTtsStream();currentReplyId='new';");
tick(500);
assert.strictEqual(spoken.length,1,'barge-in must cancel a buffered deadline');
run("feedTtsStream('The replacement reply remains correctly correlated today ')");
tick(250);
assert.strictEqual(spoken[1].replyId,'new');
assert.strictEqual(timers.size,0,'first speech must clear its deadline');
run("resetTtsStream();feedTtsStream('The whole short answer is ready. ')");
const before=spoken.length;tick(500);
assert.strictEqual(spoken.length,before,'sentence boundary must not be replayed by a timer');
// Replay subword tokens through the real loop, then flush EOF exactly as onDone.
run('resetTtsStream()'); spoken.length = 0;
const reply = 'A healthy daily routine provides lasting benefits and makes everyday life easier. The next sentence stays complete.';
for (let i = 0; i < reply.length; i += 3) {
  c.token = reply.slice(i, i + 3); run('feedTtsStream(token)'); tick(70);
}
run('clearTimeout(ttsDeadlineTimer);const remaining=ttsStreamBuf.trim();ttsStreamBuf="";if(remaining)speakChunk(remaining);');
assert.strictEqual(spoken.map(s=>s.text).join(' ').replace(/\s+/g,' '),reply,'early speech must lose or duplicate no words');
assert.strictEqual(timers.size,0);
console.log('PASS real renderer deadline: stalled stream, cancellation, supersession, no duplicate speech and lossless subword streaming');
