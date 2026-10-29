import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';

// Dotted-key segments that would reach Object.prototype (prototype pollution)
// instead of an own data property. Rejected on every get/set/delete.
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Split a dotted key; null when it's empty or contains a forbidden/empty segment. */
export function splitKey(key: unknown): string[] | null {
  if (typeof key !== 'string' || !key) return null;
  const parts = key.split('.');
  for (const part of parts) {
    if (!part || FORBIDDEN_SEGMENTS.has(part)) return null;
  }
  return parts;
}

export class JsonStore<T extends Record<string, any>> {
  private filePath: string;
  private data: T;
  private loadError: string | null = null;
  private lastGoodSnapshot: string | null = null;
  // The last state that is durably on disk; a failed save restores it so a
  // rejected write never leaves the live value changed.
  private committed = '{}';

  constructor(name: string, defaults: T) {
    // app.getPath('userData') is the real location in the packaged app; the
    // fallback only fires outside Electron (e.g. unit tests). os.homedir()/tmpdir()
    // are cross-platform (USERPROFILE on Windows, HOME on POSIX).
    const userDataPath = app?.getPath?.('userData') ?? path.join(os.homedir() || os.tmpdir(), '.aria');
    this.filePath = path.join(userDataPath, `${name}.json`);
    this.data = { ...defaults };
    this.load();
    this.committed = JSON.stringify(this.data);
  }

  get<K extends string>(key: K): unknown {
    const parts = splitKey(key);
    if (!parts) return undefined;
    let current: unknown = this.data;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      // Own properties only: inherited members (toString, constructor, …) are
      // never config values.
      if (!Object.hasOwn(current as object, part)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  set<K extends string>(key: K, value: unknown): void {
    const parts = splitKey(key);
    if (!parts) throw new Error(`Invalid config key: ${String(key)}`);
    this.assertWritable();
    let current: Record<string, unknown> = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      const child = Object.hasOwn(current, parts[i]) ? current[parts[i]] : undefined;
      // Replace a missing OR non-object intermediate with a fresh object. Note
      // `typeof null === 'object'`, so null MUST be checked explicitly — without
      // it a null intermediate (e.g. a hand-edited/corrupt `"llm": null` loaded
      // from disk) would make `current` null and the next step throw.
      if (child === null || typeof child !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
    this.save();
  }

  delete(key: string): void {
    this.assertWritable();
    const parts = splitKey(key);
    if (!parts) return;
    let current: Record<string, unknown> = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!Object.hasOwn(current, parts[i])) return;
      const child = current[parts[i]];
      // Path doesn't exist (missing, null, or a non-object) — nothing to delete.
      // Guards the same `typeof null === 'object'` trap as set().
      if (child === null || typeof child !== 'object') return;
      current = child as Record<string, unknown>;
    }
    if (!Object.hasOwn(current, parts[parts.length - 1])) return;
    delete current[parts[parts.length - 1]];
    this.save();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.markUnreadable(error);
      return;
    }
    try {
      const parsed = JSON.parse(raw, (k, v) => (FORBIDDEN_SEGMENTS.has(k) ? undefined : v));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
      Object.assign(this.data, parsed);
      this.lastGoodSnapshot = JSON.stringify(this.data, null, 2);
    } catch (error) {
      this.markUnreadable(error);
    }
  }

  private markUnreadable(error: unknown): void {
    // Never print the file body: this store also holds encrypted credentials.
    this.loadError = `Refusing to overwrite unreadable store ${this.filePath}. ` +
      `Original preserved; recover it or its .bak before restarting ARIA. ` +
      `Reason: ${(error as NodeJS.ErrnoException).code || (error instanceof SyntaxError ? 'invalid JSON' : 'invalid store')}`;
    console.error(`[ARIA] ${this.loadError}`);
  }

  private assertWritable(): void {
    if (this.loadError) throw new Error(this.loadError);
  }

  private save(): void {
    this.assertWritable();
    const dir = path.dirname(this.filePath);
    const tmp = this.filePath + '.tmp';
    let next: string;
    try {
      next = JSON.stringify(this.data, null, 2);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, next, { mode: 0o600 });
      // Bounded backup of the last successfully loaded/saved state, not an
      // unchecked disk copy that could itself have been corrupted since load.
      if (this.lastGoodSnapshot !== null) {
        const backup = this.filePath + '.bak';
        fs.writeFileSync(backup + '.tmp', this.lastGoodSnapshot, { mode: 0o600 });
        fs.renameSync(backup + '.tmp', backup);
      }
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      // Every caller mutates the live object before saving. Restoring the
      // committed snapshot keeps memory and disk consistent, so a failed save
      // (full disk, read-only userData, obstructed path) cannot leave a new
      // value — or a newly enabled privacy toggle — active in a running app.
      this.restoreCommitted();
      throw error;
    }
    this.lastGoodSnapshot = next;
    this.committed = next;
  }

  /** Roll the in-memory state back to what is durably on disk. */
  private restoreCommitted(): void {
    try {
      this.data = JSON.parse(this.committed) as T;
    } catch {
      // A committed snapshot is always valid JSON; if it somehow is not, keep
      // the current in-memory state rather than destroying it.
    }
  }
}
