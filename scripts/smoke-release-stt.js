#!/usr/bin/env node
// Real speech through the frozen STT + staged Whisper, not just a build check.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Supervisor } = require('../dist/main/supervisor');
const models = require('../dist/main/model-manager');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fixtureUrl = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.7.6/samples/jfk.wav';
const fixtureSha = '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e';

async function main() {
  const resources = process.env.ARIA_NATIVE_RESOURCES || path.join(__dirname, '..', 'build');
  const exe = process.platform === 'win32' ? '.exe' : '';
  const whisper = path.join(resources, 'whisper');
  const stt = path.join(resources, 'sidecars', 'stt', 'stt' + exe);
  assert.ok(fs.existsSync(stt), `Frozen STT missing: ${stt}`);
  assert.ok(fs.existsSync(path.join(whisper, 'bin', 'whisper-cli' + exe)), 'Staged Whisper CLI missing');
  process.env.ARIA_SIDECAR_DIR = path.join(resources, 'sidecars');
  process.env.ARIA_WHISPER_BIN_DIR = path.join(whisper, 'bin');
  process.env.ARIA_WHISPER_LIB_DIR = path.join(whisper, 'lib');
  process.env.ARIA_STT_MODEL = 'tiny.en';
  process.env.ARIA_STT_BACKEND = 'cpu';
  process.env.ARIA_STT_PROVIDER = 'local';
  process.env.ARIA_STT_THREADS = '2';
  process.env.ARIA_STT_AUDIO_CTX = '0';
  process.env.ARIA_STT_PROMPT = '';
  // Never leak inherited credentials into the native smoke child.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ARIA_STT_GROQ_') || key.startsWith('ARIA_STT_CLOUD_')) delete process.env[key];
  }
  const model = models.buildManifest('tiny.en', 'en_GB-alan-medium', 'piper')[0];
  if ((await models.missingOrInvalidModels([model])).length) await models.downloadModel(model, () => {});
  const response = await fetch(fixtureUrl, { signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `Speech fixture download failed: ${response.status}`);
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(wav).digest('hex'), fixtureSha);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') {
      assert.ok(offset + 8 + size <= wav.length);
      pcm = wav.subarray(offset + 8, offset + 8 + size);
      break;
    }
    offset += 8 + size + (size & 1);
  }
  assert.ok(pcm && pcm.length > 0, 'No speech PCM in fixture');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-native-stt-'));
  const utterance = 'release-stt';
  let acknowledged = false, result, failure, initialized = '';
  const supervisor = new Supervisor((_name, status, detail) => {
    if (status === 'initialized') initialized = detail || '';
    if (status === 'error' || status === 'exited') failure = detail || status;
  }, (_name, msg) => {
    if (msg.utterance_id !== utterance) return;
    if (msg.type === 'stt_started') acknowledged = true;
    if (msg.type === 'stt_result') result = msg.text;
    if (msg.type === 'stt_failed') failure = msg.error;
  });
  async function until(test, ms) {
    const deadline = Date.now() + ms;
    while (!test() && !failure && Date.now() < deadline) await sleep(20);
    assert.ok(!failure, `Native STT failed: ${failure}`);
    assert.ok(test(), `Native STT exceeded ${ms}ms deadline`);
  }
  const expected = text => /ask not/i.test(text) && /country/i.test(text);
  try {
    await supervisor.start('stt');
    await supervisor.waitForReady('stt', 60000);
    assert.match(initialized, /mode=server\(warm\)/, 'Frozen STT must reach real warm-server readiness');
    assert.ok(supervisor.sendToSidecar('stt', { type: 'start', utterance_id: utterance }));
    await until(() => acknowledged, 5000);
    for (let offset = 0; offset < pcm.length; offset += 8192) {
      supervisor.sendPcm('stt', pcm.subarray(offset, offset + 8192));
    }
    supervisor.sendToSidecar('stt', { type: 'transcribe', utterance_id: utterance, audio_bytes: pcm.length });
    await until(() => result !== undefined, 60000);
    assert.ok(expected(result), `Unexpected warm transcript: ${result}`);
    console.log(`PASS frozen STT real speech (${process.platform}): ${result.trim()}`);
    const wavPath = path.join(dir, 'jfk.wav');
    fs.writeFileSync(wavPath, wav);
    const env = { ...process.env };
    const lib = path.join(whisper, 'lib');
    const loader = process.platform === 'win32' ? 'PATH' : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    env[loader] = lib + path.delimiter + (env[loader] || '');
    const cli = spawnSync(path.join(whisper, 'bin', 'whisper-cli' + exe), [
      '-m', path.join(models.MODELS_DIR, model.file), '-f', wavPath,
      '--no-gpu', '--no-timestamps', '-l', 'en', '-t', '2',
    ], { env, timeout: 60000, encoding: 'utf8', windowsHide: true });
    assert.ifError(cli.error);
    assert.equal(cli.status, 0, `Native CLI failed: ${cli.status}`);
    assert.ok(expected(cli.stdout), `Unexpected CLI transcript: ${cli.stdout}`);
    console.log('PASS staged CLI real speech');
  } finally {
    await supervisor.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
