#!/usr/bin/env node
/* Test the model manager against a local mock HTTP server. Covers:
 *  - full download with progress callbacks
 *  - checksum verification (pass + mismatch)
 *  - HTTP Range resume from a .partial file
 *  - dropped/stalled responses, bounded redirects, and safe 416 promotion
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
    if (req.url === '/drop.bin') {
      res.writeHead(200, { 'Content-Length': PAYLOAD.length });
      res.write(PAYLOAD.subarray(0, 1024));
      setTimeout(() => res.socket.destroy(), 10);
      return;
    }
    if (req.url === '/stall.bin') {
      res.writeHead(200, { 'Content-Length': PAYLOAD.length });
      res.flushHeaders();
      return;
    }
    if (req.url === '/redirect-loop.bin') {
      res.writeHead(302, { Location: '/redirect-loop.bin' });
      res.end();
      return;
    }
    if (req.url === '/range-416.bin') {
      res.writeHead(416, { 'Content-Range': `bytes */${PAYLOAD.length}` });
      res.end();
      return;
    }
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

  // Same-size corruption must not bypass pinned checksums at startup.
  fs.writeFileSync(dest, Buffer.alloc(PAYLOAD.length, 0xff));
  const invalidExisting = await mm.missingOrInvalidModels([spec]);
  const c2b = invalidExisting.length === 1 && invalidExisting[0].id === spec.id;
  console.log(`[existing-checksum] invalid=${invalidExisting.length} -> ${c2b ? 'PASS' : 'FAIL'}`);
  pass = pass && c2b;
  fs.writeFileSync(dest, PAYLOAD);

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

  // Case 5: buildManifest shape — Kokoro (default) ships model + voices pack.
  const man = mm.buildManifest('small', 'bm_george');
  const c5 = man.length === 3 && man[0].file === 'ggml-small.bin'
    && man[1].file === 'kokoro-v1.0.onnx' && man[2].file === 'voices-v1.0.bin'
    && man.every((m) => Number.isInteger(m.sizeBytes) && m.sizeBytes > 0 && /^[a-f0-9]{64}$/.test(m.sha256 || ''))
    && man.every((m) => !/\/resolve\/main\//.test(m.url));
  console.log(`[manifest-kokoro]  files=${man.map(m => m.file).join(',')} -> ${c5 ? 'PASS' : 'FAIL'}`);
  pass = pass && c5;

  // Case 6: Piper fallback engine still yields per-voice .onnx + config.
  const manP = mm.buildManifest('small', 'en_GB-alan-medium', 'piper');
  let unknownPiperRejected = false;
  try { mm.buildManifest('small', 'unsupported-voice', 'piper'); } catch { unknownPiperRejected = true; }
  const c6 = manP.length === 3 && manP[1].file === 'en_GB-alan-medium.onnx'
    && manP[2].file.endsWith('.onnx.json')
    && manP.every((m) => Number.isInteger(m.sizeBytes) && m.sizeBytes > 0 && /^[a-f0-9]{64}$/.test(m.sha256 || ''))
    && manP.every((m) => !/\/resolve\/main\//.test(m.url)) && unknownPiperRejected;
  console.log(`[manifest-piper]   files=${manP.map(m => m.file).join(',')} -> ${c6 ? 'PASS' : 'FAIL'}`);
  pass = pass && c6;

  // Case 7: a dropped response must reject and must never promote a partial file.
  const dropped = { id: 'test:drop', kind: 'stt', file: 'drop.bin', url: `${base}/drop.bin`, sha256: PAYLOAD_SHA, required: true };
  let dropRejected = false;
  try { await mm.downloadModel(dropped, undefined, { responseTimeoutMs: 80, overallTimeoutMs: 200 }); } catch { dropRejected = true; }
  const c7 = dropRejected && !fs.existsSync(path.join(TMP, 'drop.bin'));
  console.log(`[dropped-response]  rejected=${dropRejected} -> ${c7 ? 'PASS' : 'FAIL'}`);
  pass = pass && c7;

  // Case 8: a stalled body is bounded by the response timeout.
  const stalled = { id: 'test:stall', kind: 'stt', file: 'stall.bin', url: `${base}/stall.bin`, sha256: PAYLOAD_SHA, required: true };
  let stallRejected = false;
  try { await mm.downloadModel(stalled, undefined, { responseTimeoutMs: 40, overallTimeoutMs: 150 }); } catch (e) { stallRejected = /timed out|timeout/i.test(e.message); }
  const c8 = stallRejected && !fs.existsSync(path.join(TMP, 'stall.bin'));
  console.log(`[stalled-response]  rejected=${stallRejected} -> ${c8 ? 'PASS' : 'FAIL'}`);
  pass = pass && c8;

  // Case 9: redirect loops are bounded rather than recursing forever.
  const looping = { id: 'test:loop', kind: 'stt', file: 'loop.bin', url: `${base}/redirect-loop.bin`, sha256: PAYLOAD_SHA, required: true };
  let loopRejected = false;
  try { await mm.downloadModel(looping, undefined, { maxRedirects: 2, overallTimeoutMs: 300 }); } catch (e) { loopRejected = /redirect/i.test(e.message); }
  const c9 = loopRejected && !fs.existsSync(path.join(TMP, 'loop.bin'));
  console.log(`[redirect-limit]    rejected=${loopRejected} -> ${c9 ? 'PASS' : 'FAIL'}`);
  pass = pass && c9;

  // Cases 10-11: HTTP 416 only promotes an already complete, verified partial.
  const partial416 = path.join(TMP, 'range-416.bin.partial');
  fs.writeFileSync(partial416, PAYLOAD);
  const good416 = { id: 'test:416-good', kind: 'stt', file: 'range-416.bin', url: `${base}/range-416.bin`, sizeBytes: PAYLOAD.length, sha256: PAYLOAD_SHA, required: true };
  await mm.downloadModel(good416);
  const c10 = fs.existsSync(path.join(TMP, 'range-416.bin')) &&
    crypto.createHash('sha256').update(fs.readFileSync(path.join(TMP, 'range-416.bin'))).digest('hex') === PAYLOAD_SHA;
  console.log(`[416-verified]       promoted=${c10} -> ${c10 ? 'PASS' : 'FAIL'}`);
  pass = pass && c10;

  const bad416Partial = path.join(TMP, 'range-416-bad.bin.partial');
  fs.writeFileSync(bad416Partial, Buffer.concat([PAYLOAD, Buffer.from([0])]));
  const bad416 = { id: 'test:416-bad', kind: 'stt', file: 'range-416-bad.bin', url: `${base}/range-416.bin`, sizeBytes: PAYLOAD.length, sha256: PAYLOAD_SHA, required: true };
  let bad416Rejected = false;
  try { await mm.downloadModel(bad416); } catch (e) { bad416Rejected = /416|size|incomplete/i.test(e.message); }
  const c11 = bad416Rejected && !fs.existsSync(path.join(TMP, 'range-416-bad.bin')) && !fs.existsSync(bad416Partial);
  console.log(`[416-incomplete]     rejected=${bad416Rejected} -> ${c11 ? 'PASS' : 'FAIL'}`);
  pass = pass && c11;

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
