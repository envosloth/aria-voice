#!/usr/bin/env node
/* Screen sharing is a consent decision, not a keyword match.
 *
 * The renderer's natural-language control used to start desktop capture from an
 * explicit refusal ("don't share my screen") and from a question about the
 * feature ("what is screen sharing?"), because the enable pattern matched the
 * fragment "screen shar…" anywhere in a sentence. Capture is auto-granted by the
 * main process (no OS picker), so a false positive here is a real privacy event.
 *
 * Runs the shipped app.js slice in a VM with stubbed capture — no Electron, no
 * screen access.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const begin = source.indexOf('const SCREEN_OFF_RE =');
const end = source.indexOf('// --- Microphone capture ---', begin);
if (begin < 0 || end <= begin) throw new Error('screen-command slice markers moved in app.js');

let pass = true;
function check(name, ok, detail = '') {
  if (!ok) pass = false;
  console.log(`[${name}] ${ok ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
}

function harness(sharing = false) {
  const calls = { start: 0, stop: 0, said: [] };
  const state = { sharing };
  const ctx = vm.createContext({
    isSharing: () => state.sharing,
    startScreenShare: async () => { calls.start += 1; state.sharing = true; },
    stopScreenShare: () => { calls.stop += 1; state.sharing = false; },
    assistantSay: (t) => calls.said.push(t),
  });
  vm.runInContext(source.slice(begin, end), ctx);
  return { ctx, state, calls };
}

async function run(text, sharing = false) {
  const h = harness(sharing);
  const handled = await vm.runInContext(`handleScreenCommand(${JSON.stringify(text)})`, h.ctx);
  return { handled, start: h.calls.start, stop: h.calls.stop, said: h.calls.said.join(' | ') };
}

(async () => {
  // Refusals must never start capture.
  for (const phrase of [
    "Don't share my screen",
    'Do not enable screen sharing',
    'I do not want to enable screen sharing',
    'Never start screen sharing',
    'Do not enable my screen',
    "Don't show my screen",
    'Never stream my screen',
  ]) {
    const r = await run(phrase);
    check(`refusal-never-starts: ${phrase}`,
      r.handled === true && r.start === 0 && r.stop === 0, JSON.stringify(r));
  }

  // Questions and discussion about the feature must not capture, and stay normal
  // conversation (no canned "stays off" reply) — explaining the feature is not a
  // local command.
  for (const phrase of [
    'What is screen sharing?', 'Is screen sharing on?', 'can you explain screen sharing',
    'How do I start screen sharing?',
    'Can you explain how to enable screen sharing?',
    'If I share my screen, can you see my password?',
    'I said "share my screen" earlier but I am asking what it does',
  ]) {
    const r = await run(phrase);
    check(`feature-question-never-starts: ${phrase}`,
      r.handled === false && r.start === 0 && r.stop === 0, JSON.stringify(r));
  }

  // Discussion is not a control command, even when it contains a negation or
  // stop verb. Check both states: a question must not silently stop a live share.
  for (const phrase of [
    "What happens if I don't share my screen?",
    'How do I avoid screen sharing?',
    'Do I need to share my screen?',
    'What happens if I stop screen sharing?',
    'Can you explain how to disable screen sharing?',
  ]) {
    for (const sharing of [false, true]) {
      const r = await run(phrase, sharing);
      check(`discussion-is-not-a-command (${sharing}): ${phrase}`,
        r.handled === false && r.start === 0 && r.stop === 0, JSON.stringify(r));
    }
  }

  // The core screen-share use case: asking about what is ON the screen is an agent
  // turn. Treating it as a sharing command swallowed it (and answered "stays off").
  for (const phrase of ['what is on my screen', "what's on my screen?", 'read this error on my screen']) {
    const r = await run(phrase);
    check(`screen-question-stays-a-turn: ${phrase}`,
      r.handled === false && r.start === 0 && r.stop === 0, JSON.stringify(r));
  }

  // A refusal while live stops capture rather than leaving it running.
  const refusalLive = await run("don't share my screen", true);
  check('refusal-while-sharing-stops', refusalLive.stop === 1 && refusalLive.start === 0, JSON.stringify(refusalLive));

  // Explicit stop still works.
  for (const phrase of ['stop sharing', 'stop screen sharing', 'turn off screen sharing']) {
    const r = await run(phrase, true);
    check(`stop-still-works: ${phrase}`, r.stop === 1 && r.start === 0, JSON.stringify(r));
  }

  // An unambiguous imperative still starts capture.
  for (const phrase of [
    'share my screen', 'start screen sharing', 'turn on screen sharing', 'begin sharing my screen',
    'Please share my screen now.', 'Could you please share my screen?', ' Aria, share my screen please! ',
  ]) {
    const r = await run(phrase);
    check(`explicit-command-starts: ${phrase}`, r.handled === true && r.start === 1 && r.stop === 0, JSON.stringify(r));
  }

  // Already sharing + another enable request stays a no-op.
  const again = await run('share my screen', true);
  check('already-sharing-is-idempotent', again.start === 0 && again.stop === 0, JSON.stringify(again));

  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
})();
