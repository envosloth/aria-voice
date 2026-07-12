import { safeStorage } from 'electron';
import { JsonStore } from './json-store';

const store = new JsonStore<Record<string, string>>('aria-secure', {});

export function getSecureBackend(): string {
  if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
  // getSelectedStorageBackend() is Linux-only; on Windows/macOS the OS-backed
  // store (DPAPI / Keychain) is always used when encryption is available.
  if (process.platform === 'win32') return 'dpapi';
  if (process.platform === 'darwin') return 'keychain';
  if (typeof safeStorage.getSelectedStorageBackend === 'function') {
    return safeStorage.getSelectedStorageBackend();
  }
  return 'os_crypt';
}

// Kept pure so policy is testable without initializing Electron's safeStorage.
export function isSecureBackendNameSafe(backend: string): boolean {
  return backend !== 'unavailable' && backend !== 'basic_text';
}

export function isSecureBackendSafe(): boolean {
  return isSecureBackendNameSafe(getSecureBackend());
}

function requireSecureBackend(): void {
  const backend = getSecureBackend();
  if (!isSecureBackendNameSafe(backend)) {
    // There is deliberately no implicit basic_text escape hatch. This app has no
    // existing user-approved insecure-storage opt-in, so persisting a key here
    // would turn an OS-keyring promise into plaintext-obfuscation at rest.
    throw new Error(
      `Refusing to persist a secret with insecure safeStorage backend "${backend}". ` +
      'Install or unlock the OS keyring first.',
    );
  }
}

export function setSecret(key: string, value: string): void {
  requireSecureBackend();
  const encrypted = safeStorage.encryptString(value);
  store.set(key, encrypted.toString('base64'));
}

export function getSecret(key: string): string | null {
  // Do not decrypt previously-written basic_text blobs. Delete remains allowed
  // so a user can remove a stale insecure record after restoring their keyring.
  if (!isSecureBackendSafe()) return null;
  const encoded = store.get(key) as string | undefined;
  if (!encoded) return null;

  const encrypted = Buffer.from(encoded, 'base64');
  return safeStorage.decryptString(encrypted);
}

export function deleteSecret(key: string): void {
  store.delete(key);
}
