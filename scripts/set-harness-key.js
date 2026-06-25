// One-off helper: write ARIA's `harness-api-key` into the encrypted secure store
// using the same Electron safeStorage the app uses (same user + keyring, so the
// packaged app can decrypt it). Reads the key value from argv[2].
//
//   ./node_modules/.bin/electron scripts/set-harness-key.js <KEY>
//
// Self-verifies with an encrypt->decrypt round trip and backs up the store file
// before writing; restores the backup if verification fails.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const KEY_NAME = 'harness-api-key';
// Prefer the env var (immune to Electron/Chromium argv mangling); fall back to argv.
const value = process.env.ARIA_HARNESS_KEY || process.argv[2];

app.setName('aria'); // match the packaged app's userData dir (~/.config/aria)

app.whenReady().then(() => {
  const out = (o) => { console.log(JSON.stringify(o)); };
  try {
    if (!value) throw new Error('no key provided');
    const userData = app.getPath('userData');
    const file = path.join(userData, 'aria-secure.json');
    const backend = safeStorage.isEncryptionAvailable() ? safeStorage.getSelectedStorageBackend() : 'unavailable';

    // Round-trip sanity check first.
    const probe = safeStorage.decryptString(safeStorage.encryptString('roundtrip-probe'));
    if (probe !== 'roundtrip-probe') throw new Error('safeStorage round trip failed');

    const store = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');

    const enc = safeStorage.encryptString(value).toString('base64');
    store[KEY_NAME] = enc;
    fs.writeFileSync(file, JSON.stringify(store, null, 2));

    // Verify what we wrote decrypts back to the original.
    const check = safeStorage.decryptString(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8'))[KEY_NAME], 'base64'));
    if (check !== value) {
      if (fs.existsSync(file + '.bak')) fs.copyFileSync(file + '.bak', file);
      throw new Error('verification mismatch — restored backup');
    }
    out({ ok: true, backend, file, name: app.getName(), len: value.length });
    app.exit(0);
  } catch (e) {
    out({ ok: false, error: String(e && e.message || e), name: app.getName() });
    app.exit(1);
  }
});
