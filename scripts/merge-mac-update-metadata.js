#!/usr/bin/env node
/* Merge architecture-specific electron-builder macOS metadata after native builds. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

async function sha512(file) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

function installerFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(zip|dmg)$/.test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

function order(name) {
  if (name.endsWith('-arm64-mac.zip')) return 0;
  if (name.endsWith('-mac.zip')) return 1;
  if (name.endsWith('-arm64.dmg')) return 2;
  if (name.endsWith('.dmg')) return 3;
  return 4;
}

async function main() {
  const [armDir, x64Dir, output] = process.argv.slice(2);
  if (!armDir || !x64Dir || !output) {
    throw new Error('usage: merge-mac-update-metadata.js <arm64-dir> <x64-dir> <output>');
  }

  const files = [...installerFiles(armDir), ...installerFiles(x64Dir)]
    .sort((a, b) => order(path.basename(a)) - order(path.basename(b)));
  if (files.length !== 4) {
    throw new Error(`expected arm64/x64 zip+dmg files (4 total), found ${files.length}`);
  }

  const records = [];
  for (const file of files) {
    records.push({
      name: path.basename(file),
      size: fs.statSync(file).size,
      sha512: await sha512(file),
    });
  }
  const preferred = records.find((record) => record.name.endsWith('-arm64-mac.zip'));
  if (!preferred) throw new Error('missing arm64 mac zip');

  const version = require(path.join(__dirname, '..', 'package.json')).version;
  const lines = [`version: ${version}`, 'files:'];
  for (const record of records) {
    lines.push(`  - url: ${record.name}`, `    sha512: ${record.sha512}`, `    size: ${record.size}`);
  }
  lines.push(
    `path: ${preferred.name}`,
    `sha512: ${preferred.sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, lines.join('\n'));
  console.log(`Merged ${records.length} macOS artifacts -> ${output}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
