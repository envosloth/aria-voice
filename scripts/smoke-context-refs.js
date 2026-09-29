#!/usr/bin/env node
/* Context awareness (roadmap P0.3): which context an utterance refers to, and
 * the prompt block built from a captured snapshot. Pure — no desktop needed. */
const path = require('path');
const C = require(path.join(__dirname, '..', 'dist', 'main', 'context-refs'));

let pass = true;
function check(name, cond, detail) {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
}
const refs = (t) => C.detectContextRefs(t);
const has = (t, k) => refs(t).includes(k);

// Explicit sources.
check('clipboard-copied', has('explain what I copied', 'clipboard'));
check('clipboard-word', has("what's on my clipboard", 'clipboard'));
check('clipboard-pasted', has('summarize the text I just copied', 'clipboard'));
check('selection-selected', has('translate the selected text', 'selection'));
check('selection-highlighted', has('what does the highlighted part mean', 'selection'));
check('app-which', has('what app am I in', 'activeApp'));
check('app-window', has('what is this window', 'activeApp'));
check('page-this', has('summarize this page', 'page'));
check('page-article', has('give me the gist of this article', 'page'));
check('page-site', has('is this website legit', 'page'));
// Bare deictic + text verb: selection first, clipboard as fallback, app for grounding.
const d = refs('summarize this');
check('deictic-summarize', d.includes('selection') && d.includes('clipboard') && d.includes('activeApp'), JSON.stringify(d));
check('deictic-translate', has('translate this to Spanish', 'selection'));
check('deictic-meaning', has('what does this mean', 'selection'));
check('deictic-error', has('what is this error', 'selection') && has('what is this error', 'activeApp'));
check('deictic-reply', has('help me reply to this', 'selection'));
check('deictic-fix-that', has('can you fix that sentence', 'selection'));
check('deictic-proofread', has('proofread this for me', 'selection'));
check('deictic-typos', has('check this for typos', 'selection'));
// Held-out phrasing checked after tightening (bare "it" and "that <clause>" are conversational).
for (const t of ['explain it like I am five, what is gravity', 'reply to Sam that I am running late',
  'I need to fix it before Friday, any advice', 'check it out, I got a new job', 'read it back to me',
  'check that the door is locked', 'fix this weekend plan']) {
  check(`no-ref-heldout: ${t}`, refs(t).length === 0, JSON.stringify(refs(t)));
}
// No reference: never capture.
for (const t of ['what is the weather this weekend', 'that sounds great', 'this morning I went running',
  'tell me a joke', 'what time is it', 'is this a good idea to learn rust', 'I like this song',
  'remind me to call mom this afternoon', 'what did I do this week', 'thanks, that helps']) {
  check(`no-ref: ${t}`, refs(t).length === 0, JSON.stringify(refs(t)));
}

// Block building.
const snap = {
  activeApp: { app: 'firefox', title: 'Rust ownership explained - Mozilla Firefox' },
  selection: 'Ownership is a set of rules that govern how a Rust program manages memory.',
  clipboard: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html',
};
const b = C.buildContextBlock(snap, ['selection', 'clipboard', 'activeApp']);
check('block-has-selection', b.text.includes('Ownership is a set of rules'));
check('block-selection-preferred', b.used.map((u) => u.kind).join(',') === 'activeApp,selection', JSON.stringify(b.used));
check('block-frames-as-data', /not instructions/i.test(b.text));
check('block-names-app', /firefox/i.test(b.text) && /Rust ownership explained/.test(b.text));
const clipOnly = C.buildContextBlock({ ...snap, selection: '' }, ['selection', 'clipboard', 'activeApp']);
check('block-falls-back-to-clipboard', clipOnly.used.some((u) => u.kind === 'clipboard') && clipOnly.text.includes('doc.rust-lang.org'));
const page = C.buildContextBlock(snap, ['page']);
check('page-uses-browser-title-and-url', page.text.includes('Rust ownership explained') && page.text.includes('doc.rust-lang.org')
  && page.used.some((u) => u.kind === 'page'), page.text);
const notBrowser = C.buildContextBlock({ activeApp: { app: 'kitty', title: 'vim' }, clipboard: '' }, ['page']);
check('page-needs-browser', !notBrowser.used.some((u) => u.kind === 'page'));
const huge = C.buildContextBlock({ selection: 'x'.repeat(50000) }, ['selection'], 4000);
check('block-truncates', huge.text.length < 4400 && huge.used[0].truncated === true);
const none = C.buildContextBlock({}, ['selection', 'clipboard']);
check('block-empty-when-nothing', none.text === '' && none.used.length === 0);
check('secret-api-key', C.looksLikeSecret('sk-proj-AbCdEf1234567890AbCdEf1234567890') === true);
check('secret-jwt', C.looksLikeSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U') === true);
check('secret-prose-ok', C.looksLikeSecret('Ownership is a set of rules that govern memory.') === false);
const keyClip = C.buildContextBlock({ clipboard: 'sk-proj-AbCdEf1234567890AbCdEf1234567890' }, ['clipboard']);
check('block-withholds-secret', !keyClip.text.includes('sk-proj') && keyClip.used.length === 1 && keyClip.used[0].withheld === true);
// Files attached in the composer.
const f = C.buildContextBlock({ files: [{ name: 'notes.md', text: '# Plan\nship memory' }] }, []);
check('files-always-included', f.text.includes('notes.md') && f.text.includes('ship memory') && f.used[0].kind === 'file');

// Routing hint: text work on attached text is chat work.
check('text-work-summarize', C.isTextWorkOnContext('summarize this') === true);
check('text-work-translate', C.isTextWorkOnContext('translate this to Spanish') === true);
check('text-work-not-open', C.isTextWorkOnContext('open this file') === false);
check('text-work-not-run', C.isTextWorkOnContext('run this command') === false);

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
