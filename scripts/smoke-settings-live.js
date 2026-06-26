#!/usr/bin/env node
/* Item 1 verification: a setting consumed only by a sidecar at spawn (tts.voice)
 * takes effect WITHOUT an app restart.
 *
 * Boots the real app headless in an isolated --user-data-dir (so the user's real
 * config is untouched), starts the TTS sidecar, then changes tts.voice through
 * the genuine config IPC path. The TTS sidecar should reload IN THE SAME running
 * app process and come back initialized with the new voice — proving live apply.
 *
 * PASS when we observe two TTS 'initialized' status lines from one process: the
 * first with the default voice, the second with the newly-set voice.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const NEW_VOICE = 'af_sarah';

function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-verify-'));
  const electron = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const child = spawn(electron, [
    '--no-sandbox', `--user-data-dir=${userDir}`,
    path.join(__dirname, '..', 'dist', 'main', 'index.js'),
  ], {
    env: { ...process.env, ARIA_SMOKE: '1', ARIA_VERIFY_SETTINGS: '1', ARIA_VERIFY_VOICE: NEW_VOICE },
  });

  const voices = [];           // tts voices seen at each 'initialized', in order
  let buf = '';
  const reInit = /\[ARIA_SMOKE\]\[tts\] initialized:.*voice=(\S+)/;
  let done = false;

  const finish = (ok, why) => {
    if (done) return;
    done = true;
    try { child.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
    console.log(`\nTTS voices observed (one running process): ${JSON.stringify(voices)}`);
    console.log(`=== RESULT: ${ok ? 'PASS' : 'FAIL'} === ${why}`);
    process.exit(ok ? 0 : 1);
  };

  const onLine = (line) => {
    if (process.env.VERBOSE) console.log(line);
    if (/\[ARIA_VERIFY\]/.test(line)) console.log(line);
    const m = line.match(reInit);
    if (m) {
      voices.push(m[1]);
      // First reload that yields the new voice while the same process keeps
      // running == live apply, no restart.
      if (voices.length >= 2 && voices[voices.length - 1] === NEW_VOICE && voices[0] !== NEW_VOICE) {
        finish(true, `voice went ${voices[0]} -> ${NEW_VOICE} live (no app restart)`);
      }
    }
  };

  const pump = (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) onLine(l);
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);

  child.on('exit', () => finish(false, `process exited; voices=${JSON.stringify(voices)}`));
  setTimeout(() => finish(false, 'timed out waiting for live voice change'), 60000);
}

main();
