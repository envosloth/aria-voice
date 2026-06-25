#!/usr/bin/env node
/* Unit test for the LLM<->harness router. */
const { route } = require('../dist/main/router');
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

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
