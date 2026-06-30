#!/usr/bin/env node
/* Unit test for the LLM<->harness router. */
const { route, visionDetailFor } = require('../dist/main/router');
const both = { mode: 'auto', hasLlm: true, hasHarness: true };
let pass = true;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) pass = false;
  console.log(`[${name}] ${got} ${ok ? '==' : '!= ' + want + ' ->'} ${ok ? 'PASS' : 'FAIL'}`);
}

// Agentic -> harness
check('code', route('can you fix the bug in app.js', both), 'harness');
check('run', route('run the test suite', both), 'harness');
check('file', route('create a file called notes.txt', both), 'harness');
check('git', route('commit these changes', both), 'harness');
// Conversational -> llm
check('chat', route('what is the capital of France', both), 'llm');
check('weather', route('how are you today', both), 'llm');
// Explicit overrides
check('explicit-harness', route('use the agent to summarize this', both), 'harness');
check('explicit-llm', route('just chat, what time is it', both), 'llm');
check('agent-prefix', route('agent: open the repo', both), 'harness');
// Availability fallbacks
check('only-harness', route('hello there', { mode: 'auto', hasLlm: false, hasHarness: true }), 'harness');
check('only-llm', route('fix the code', { mode: 'auto', hasLlm: true, hasHarness: false }), 'llm');
check('mode-harness', route('hello', { mode: 'harness', hasLlm: true, hasHarness: true }), 'harness');
check('mode-llm', route('fix the code', { mode: 'llm', hasLlm: true, hasHarness: true }), 'llm');
check('none', route('hi', { mode: 'auto', hasLlm: false, hasHarness: false }), 'llm');
// Real-time / tool intent -> harness (the "ask Alexa for weather" bug)
check('weather-realtime', route('what is the weather for my location', both), 'harness');
check('news', route('give me the latest news headlines', both), 'harness');
check('lookup', route('look up the score of the game', both), 'harness');
// Stickiness: short follow-up after a harness turn continues on the harness
check('sticky-followup', route('Austin, Texas', { ...both, lastTarget: 'harness' }), 'harness');
check('sticky-yes', route('yes go ahead', { ...both, lastTarget: 'harness' }), 'harness');
// ...but an explicit "just chat" still escapes to the LLM
check('sticky-escape', route('just chat for a sec', { ...both, lastTarget: 'harness' }), 'llm');
// A long fresh question after a harness turn is NOT treated as a continuation
check('no-sticky-long', route('what is the capital of France and tell me about its history please', { ...both, lastTarget: 'harness' }), 'llm');
// No stickiness when the LLM handled the previous turn
check('llm-no-sticky', route('Austin, Texas', { ...both, lastTarget: 'llm' }), 'llm');
// A long answer to a harness question still goes to the harness (lastWasQuestion)
check('answer-to-question', route('I am currently located in Austin, Texas in the United States', { ...both, lastTarget: 'harness', lastWasQuestion: true }), 'harness');

// --- Expanded tool-intent recall (the "handed to the LLM when a tool was clearly
// needed" complaint). These all need a tool/live data -> harness. ---
check('what-time', route('what time is it', both), 'harness');
check('todays-date', route("what's today's date", both), 'harness');
check('rain-tomorrow', route('will it rain tomorrow', both), 'harness');
check('set-timer', route('set a timer for 10 minutes', both), 'harness');
check('set-alarm', route('set an alarm for 7am', both), 'harness');
check('play-music', route('play some jazz', both), 'harness');
check('open-app', route('open spotify', both), 'harness');
check('remind', route('remind me to call mom at noon', both), 'harness');
check('bitcoin-now', route('how much is bitcoin right now', both), 'harness');
check('directions', route('directions to the airport', both), 'harness');
check('latest', route("what's the latest on the election", both), 'harness');
check('translate', route('translate good morning into Spanish', both), 'harness');
check('convert', route('convert 10 miles to kilometers', both), 'harness');
check('send-text', route('send a text to Alex', both), 'harness');
check('calendar', route("what's on my calendar today", both), 'harness');
check('nearby', route('find a coffee shop near me', both), 'harness');

// --- Still conversational -> llm (must NOT over-route to the harness). ---
check('joke', route('tell me a joke', both), 'llm');
check('capital', route('what is the capital of France', both), 'llm');
check('how-today', route('how are you today', both), 'llm');
check('opinion', route('what do you think about jazz music', both), 'llm');
check('explain', route('explain how photosynthesis works', both), 'llm');
check('in-order-to', route('in order to learn, what should I read about history', both), 'llm');

// --- Screen-share vision detail: glance -> low (fast), reading -> high (legible) ---
check('vd-whats-on-screen', visionDetailFor("what's on my screen"), 'low');
check('vd-what-am-i-looking-at', visionDetailFor('what am I looking at'), 'low');
check('vd-what-app', visionDetailFor('what app is this'), 'low');
check('vd-describe-screen', visionDetailFor('describe my screen'), 'low');
check('vd-read-error', visionDetailFor('help me fix this error'), 'high');
check('vd-read-code', visionDetailFor('what does this code do'), 'high');
check('vd-summarize-doc', visionDetailFor('summarize this document for me'), 'high');
check('vd-default-high', visionDetailFor('is this design any good'), 'high');

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
