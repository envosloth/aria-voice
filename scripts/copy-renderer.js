#!/usr/bin/env node
/* Copy the renderer's static assets into dist/renderer.
 *
 * Replaces the old `mkdir -p dist/renderer && cp src/renderer/*.js ...` shell
 * step in the npm "build" script. npm runs script bodies through cmd.exe on
 * Windows (not the calling shell), where `mkdir -p`, forward-slash paths, and
 * `cp` are invalid ("The syntax of the command is incorrect.") — that was the
 * Windows release-build failure. Node's fs is identical on every platform. */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'renderer');
const outDir = path.join(__dirname, '..', 'dist', 'renderer');
const files = [
  'index.html', 'app.js', 'audio-utils.js', 'mic-worklet.js',
  'harnesses.js', 'orb.js', 'perf.js',
];

fs.mkdirSync(outDir, { recursive: true });
for (const f of files) {
  fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
}
console.log(`[copy-renderer] copied ${files.length} files -> dist/renderer`);
