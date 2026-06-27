#!/usr/bin/env node
/* Unit test for the in-app update progress bar (renderer side of item 1).
 *
 * The updater backend already emits { state:'downloading', percent } — this test
 * guards the RENDERER wiring that turns that into a visible, moving bar so the
 * user isn't left wondering whether an update stalled.
 *
 * It (a) asserts the markup + CSS contract and the onStatus switch wiring, and
 * (b) extracts the shipped setUpdateProgress() and RUNS it against a fake element,
 * so the determinate/indeterminate/hide behaviour is tested on the real code. */
const fs = require('fs');
const path = require('path');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

let pass = true;
function check(name, cond, detail) {
  if (!cond) pass = false;
  console.log(`[${name}] ${cond ? 'PASS' : 'FAIL' + (detail ? ' -> ' + detail : '')}`);
}

// --- markup + CSS contract ---
check('markup.progress', /id="update-progress"/.test(htmlSrc));
check('css.value', /\.update-progress::-webkit-progress-value/.test(htmlSrc));
check('css.indeterminate', /\.update-progress\.indeterminate/.test(htmlSrc) && /@keyframes update-indet/.test(htmlSrc));

// --- onStatus switch wiring (locks each state to the right progress call) ---
check('wire.downloading', /case 'downloading':[\s\S]*?setUpdateProgress\(s\.percent != null \? s\.percent : 'indeterminate'\)/.test(appSrc));
check('wire.installing.indet', /case 'installing':[\s\S]*?setUpdateProgress\('indeterminate'\)/.test(appSrc));
check('wire.downloaded.hide', /case 'downloaded':[\s\S]*?setUpdateProgress\('hide'\)/.test(appSrc));
check('wire.installed.hide', /case 'installed':[\s\S]*?setUpdateProgress\('hide'\)/.test(appSrc));
check('wire.error.hide', /case 'error':[\s\S]*?setUpdateProgress\('hide'\)/.test(appSrc));

// --- run the shipped setUpdateProgress against a fake <progress> element ---
class FakeEl {
  constructor() { this.style = { display: '' }; this._cls = new Set(); this.value = undefined; }
  get classList() {
    const s = this._cls;
    return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
  }
  removeAttribute(a) { if (a === 'value') this.value = undefined; }
}
const m = appSrc.match(/function setUpdateProgress\(state\) \{[\s\S]*?\n\}/);
check('fn.present', !!m, 'setUpdateProgress not found');
const el = new FakeEl();
const setUpdateProgress = m ? Function('upd', `${m[0]}\nreturn setUpdateProgress;`)({ progress: el }) : () => {};

setUpdateProgress('hide');
check('hide.hidden', el.style.display === 'none');

setUpdateProgress('indeterminate');
check('indet.shown', el.style.display === '');
check('indet.class', el._cls.has('indeterminate'));
check('indet.novalue', el.value === undefined);

setUpdateProgress(42);
check('det.shown', el.style.display === '');
check('det.value', el.value === 42);
check('det.class.cleared', !el._cls.has('indeterminate'));

setUpdateProgress(250);  check('det.clamp.high', el.value === 100);
setUpdateProgress(-10);  check('det.clamp.low', el.value === 0);

setUpdateProgress('hide');
check('hide.again', el.style.display === 'none');

console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
