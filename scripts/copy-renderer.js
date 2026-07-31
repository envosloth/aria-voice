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
  'index.html', 'app.js', 'audio-utils.js', 'mic-lifecycle.js', 'mic-worklet.js',
  'harnesses.js', 'orb.js', 'perf.js',
];
const assets = ['aria-orb.webm', 'aria-orb-compact.png'];
const srcAssetsDir = path.join(srcDir, 'assets');
const outAssetsDir = path.join(outDir, 'assets');

fs.mkdirSync(outDir, { recursive: true });
for (const f of files) {
  fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
}
// The GIF is the checked-in source reference used to derive the seekable WebM;
// it is not loaded at runtime. Recreate the asset directory so stale source media
// from an earlier build cannot silently inflate installers.
fs.rmSync(outAssetsDir, { recursive: true, force: true });
fs.mkdirSync(outAssetsDir, { recursive: true });
for (const asset of assets) {
  fs.copyFileSync(path.join(srcAssetsDir, asset), path.join(outAssetsDir, asset));
}
console.log(`[copy-renderer] copied ${files.length} files and ${assets.length} runtime assets -> dist/renderer`);
