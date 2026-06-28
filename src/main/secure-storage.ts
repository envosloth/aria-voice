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

export function isSecureBackendSafe(): boolean {
  const backend = getSecureBackend();
  return backend !== 'unavailable' && backend !== 'basic_text';
}

export function setSecret(key: string, value: string): void {
  const encrypted = safeStorage.encryptString(value);
  store.set(key, encrypted.toString('base64'));
}

export function getSecret(key: string): string | null {
  const encoded = store.get(key) as string | undefined;
  if (!encoded) return null;

  const encrypted = Buffer.from(encoded, 'base64');
  return safeStorage.decryptString(encrypted);
}

export function deleteSecret(key: string): void {
  store.delete(key);
}
