#!/usr/bin/env node
const assert = require('assert');
const A = require('../src/renderer/audio-utils.js');
const prefix = 'A healthy daily routine provides lasting benefits ';
assert.strictEqual(A.nextTtsCut(prefix, true, 249), -1, 'normal boundaries stay unchanged before deadline');
assert.strictEqual(A.nextTtsCut(prefix, true, 250), prefix.length, 'complete first phrase must flush at deadline');
assert.strictEqual(A.nextTtsCut('A healthy daily routine provides ', true, 1000), -1, 'five words must not become a fragment');
assert.strictEqual(A.nextTtsCut('A healthy daily routine provides lasting bene', true, 1000), 'A healthy daily routine provides lasting '.length, 'never split a streamed word');
assert.strictEqual(A.nextTtsCut('A healthy daily routine provides lasting benefits and ', true, 1000), prefix.length, 'keep an open conjunction for the next phrase');
assert.strictEqual(A.nextTtsCut(prefix, false, 1000), -1, 'later chunks still prefer sentences');
let buf = prefix + 'and makes everyday life easier.';
let cut = A.nextTtsCut(buf, true, 250);
assert.strictEqual(buf.slice(0, cut) + buf.slice(cut), buf, 'cut preserves every character');
console.log('PASS first TTS deadline: bounded wait, whole words, fragment/open-ending guards, later prosody and lossless slicing');
