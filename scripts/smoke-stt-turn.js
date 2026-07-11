#!/usr/bin/env node
/* Regression tests for STT utterance correlation and exactly-once delivery. */

const fs = require('fs');
const path = require('path');
const { SttTurnGate } = require('../dist/main/stt-turn');

let pass = true;
function check(name, cond, detail) {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
}

// Audio received while the sidecar is starting must be held, then flushed only
// after its reset/start acknowledgement. Ending during startup must still issue
// exactly one transcription with the complete expected byte count.
const gate = new SttTurnGate(1024);
gate.begin('turn-a');
const first = Buffer.from([1, 2, 3, 4]);
check('startup-audio-is-buffered', gate.pushAudio(first) === null);
check('end-waits-for-start-ack', gate.end() === null);
const ready = gate.ackStarted('turn-a');
check('ack-flushes-startup-audio', !!ready && ready.chunks.length === 1 && ready.chunks[0].equals(first));
check('ack-transcribes-complete-audio', !!ready && !!ready.transcribe && ready.transcribe.turnId === 'turn-a' && ready.transcribe.audioBytes === first.length);

// A result is accepted once. A duplicate from the sidecar and a stale result from
// an interrupted prior utterance must never become extra chat turns.
check('current-result-accepted-once', gate.acceptResult('turn-a') === true);
check('duplicate-result-rejected', gate.acceptResult('turn-a') === false);
gate.begin('turn-b');
gate.pushAudio(Buffer.from([5, 6]));
check('stale-result-rejected', gate.acceptResult('turn-a') === false);
const readyB = gate.ackStarted('turn-b');
check('current-start-ack-accepted', !!readyB && readyB.chunks.length === 1);
const transcribeB = gate.end();
check('ready-end-transcribes-once', !!transcribeB && transcribeB.turnId === 'turn-b' && transcribeB.audioBytes === 2);
check('second-end-is-noop', gate.end() === null);
check('new-result-accepted', gate.acceptResult('turn-b') === true);

// Repeated wake-word events while already listening are blocked in the renderer;
// otherwise each event resets the same live audio and can create duplicate/stale
// turn traffic before VAD ends the utterance.
const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const beginBody = appSource.match(/function beginUtterance\(opts\) \{([\s\S]*?)\n\}/);
check('renderer-guards-repeated-begin', !!beginBody && /if \(listening\) return;/.test(beginBody[1]));
const wakeBody = appSource.match(/aria\.wakeword\.onDetected\([^=]*=> \{([\s\S]*?)\n\}\);/);
check('duplicate-wake-does-not-chime', !!wakeBody
  && wakeBody[1].indexOf('if (listening) return;') < wakeBody[1].indexOf('playWakeChime()'));

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
