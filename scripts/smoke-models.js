#!/usr/bin/env node
/* Test the model manager against a local mock HTTP server. Covers:
 *  - full download with progress callbacks
 *  - checksum verification (pass + mismatch)
 *  - HTTP Range resume from a .partial file
 *  - missingModels / isPresent detection
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Point the model manager at a throwaway dir BEFORE requiring it
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-models-'));
process.env.ARIA_MODELS_DIR = TMP;

const mm = require('../dist/main/model-manager');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Build a deterministic payload
const PAYLOAD = Buffer.alloc(256 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 256;
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

function makeServer() {
  return http.createServer((req, res) => {
    const range = req.headers['range'];
    if (range) {
      const m = range.match(/bytes=(\d+)-/);
      const start = m ? parseInt(m[1], 10) : 0;
      const slice = PAYLOAD.subarray(start);
      res.writeHead(206, {
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      });
      res.end(slice);
    } else {
      res.writeHead(200, { 'Content-Length': PAYLOAD.length });
      res.end(PAYLOAD);
    }
  });
}

async function main() {
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let pass = true;

  // Case 1: full download + progress + checksum OK
  const spec = { id: 'test:model', kind: 'stt', file: 'test-model.bin', url: `${base}/model.bin`, sha256: PAYLOAD_SHA, required: true };
  let lastPct = 0; let progressCalls = 0;
  await mm.downloadModel(spec, (p) => { lastPct = p.percent; progressCalls++; });
  const dest = path.join(TMP, 'test-model.bin');
  const c1 = fs.existsSync(dest) && fs.statSync(dest).size === PAYLOAD.length && lastPct === 100 && progressCalls > 0;
  console.log(`[download+checksum] size=${fs.existsSync(dest) ? fs.statSync(dest).size : 0} pct=${lastPct} calls=${progressCalls} -> ${c1 ? 'PASS' : 'FAIL'}`);
  pass = pass && c1;

  // Case 2: isPresent / missingModels
  const c2 = mm.isPresent(spec) && mm.missingModels([spec]).length === 0;
  console.log(`[isPresent]        present=${mm.isPresent(spec)} -> ${c2 ? 'PASS' : 'FAIL'}`);
  pass = pass && c2;

  // Case 3: checksum mismatch -> rejects and removes partial
  const badSpec = { id: 'test:bad', kind: 'stt', file: 'bad-model.bin', url: `${base}/model.bin`, sha256: 'deadbeef', required: true };
  let rejected = false;
  try { await mm.downloadModel(badSpec); } catch (e) { rejected = /mismatch/i.test(e.message); }
  const c3 = rejected && !fs.existsSync(path.join(TMP, 'bad-model.bin'));
  console.log(`[checksum-bad]     rejected=${rejected} -> ${c3 ? 'PASS' : 'FAIL'}`);
  pass = pass && c3;

  // Case 4: Range resume — pre-seed a .partial with the first half
  const resumeSpec = { id: 'test:resume', kind: 'stt', file: 'resume-model.bin', url: `${base}/model.bin`, sha256: PAYLOAD_SHA, required: true };
  const partialPath = path.join(TMP, 'resume-model.bin.partial');
  fs.writeFileSync(partialPath, PAYLOAD.subarray(0, PAYLOAD.length / 2));
  let resumeStart = -1;
  await mm.downloadModel(resumeSpec, (p) => { if (resumeStart < 0) resumeStart = p.received; });
  const resumeDest = path.join(TMP, 'resume-model.bin');
  const finalOk = fs.existsSync(resumeDest) && crypto.createHash('sha256').update(fs.readFileSync(resumeDest)).digest('hex') === PAYLOAD_SHA;
  // resume should start near the half-way mark, not from 0
  const c4 = finalOk && resumeStart >= PAYLOAD.length / 2;
  console.log(`[range-resume]     resumeStartByte=${resumeStart} (half=${PAYLOAD.length / 2}) finalOk=${finalOk} -> ${c4 ? 'PASS' : 'FAIL'}`);
  pass = pass && c4;

  // Case 5: buildManifest shape
  const man = mm.buildManifest('small', 'en_US-lessac-medium');
  const c5 = man.length === 3 && man[0].file === 'ggml-small.bin' && man[1].file === 'en_US-lessac-medium.onnx' && man[2].file.endsWith('.onnx.json');
  console.log(`[manifest]         files=${man.map(m => m.file).join(',')} -> ${c5 ? 'PASS' : 'FAIL'}`);
  pass = pass && c5;

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
