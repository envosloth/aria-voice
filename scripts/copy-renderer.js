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
  'harnesses.js', 'orb.js', 'perf.js', 'appearance.js', 'ux.css', 'speech-settings.js',
  'tactile.css', 'tactile.js', 'liquid.css', 'liquid.js',
];
// The orb is procedural (orb.js); no runtime media ships with the renderer.
const outAssetsDir = path.join(outDir, 'assets');

fs.mkdirSync(outDir, { recursive: true });
for (const f of files) {
  fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
}
// Remove media left by earlier builds (the retired orb video) so it cannot
// silently inflate installers.
fs.rmSync(outAssetsDir, { recursive: true, force: true });
fs.mkdirSync(outAssetsDir, { recursive: true });
fs.copyFileSync(path.join(srcDir, '..', '..', 'assets', 'icon.png'), path.join(outAssetsDir, 'icon.png'));
console.log(`[copy-renderer] copied ${files.length} files -> dist/renderer`);
