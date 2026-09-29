// App binding for user memory: one MemoryStore in userData, encrypted with
// Electron safeStorage when the OS keyring is trustworthy. When it is not
// (no keyring / basic_text), memory still works but is stored as owner-only
// plaintext and the Memory panel says so — the user sees the tradeoff.

import path from 'path';
import { app, safeStorage } from 'electron';
import { MemoryStore, MemoryCodec } from './user-memory';
import { isSecureBackendSafe } from './secure-storage';

let store: MemoryStore | null = null;

function codec(): MemoryCodec {
  if (isSecureBackendSafe()) {
    return {
      encrypted: true,
      encode: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decode: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
    };
  }
  return { encrypted: false, encode: (s) => s, decode: (s) => s };
}

export function memoryStore(): MemoryStore {
  if (!store) {
    // smoke-user-data.ts already redirects userData for isolated test runs.
    store = new MemoryStore(path.join(app.getPath('userData'), 'aria-memory.json'), codec());
  }
  return store;
}
