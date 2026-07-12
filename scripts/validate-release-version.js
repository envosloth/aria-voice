#!/usr/bin/env node
/* Validate the version in a vX.Y.Z tag against package.json and package-lock. */

const fs = require('fs');
const path = require('path');

const [tag, root = path.join(__dirname, '..')] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag || '')) {
  console.error(`Expected a vX.Y.Z release tag, got ${JSON.stringify(tag)}.`);
  process.exit(1);
}

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const tagVersion = tag.slice(1);
  const lockRootVersion = lock.packages && lock.packages[''] && lock.packages[''].version;
  if (pkg.version !== tagVersion || lock.version !== tagVersion || lockRootVersion !== tagVersion) {
    throw new Error(`tag=${tagVersion}, package=${pkg.version}, lock=${lock.version}, lockRoot=${lockRootVersion}`);
  }
  console.log(`Release version verified: ${tagVersion}`);
} catch (err) {
  console.error(`Release version mismatch: ${err.message}`);
  process.exit(1);
}
