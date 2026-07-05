import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';

export class JsonStore<T extends Record<string, any>> {
  private filePath: string;
  private data: T;

  constructor(name: string, defaults: T) {
    // app.getPath('userData') is the real location in the packaged app; the
    // fallback only fires outside Electron (e.g. unit tests). os.homedir()/tmpdir()
    // are cross-platform (USERPROFILE on Windows, HOME on POSIX).
    const userDataPath = app?.getPath?.('userData') ?? path.join(os.homedir() || os.tmpdir(), '.aria');
    this.filePath = path.join(userDataPath, `${name}.json`);
    this.data = { ...defaults };
    this.load();
  }

  get<K extends string>(key: K): unknown {
    const parts = key.split('.');
    let current: unknown = this.data;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  set<K extends string>(key: K, value: unknown): void {
    const parts = key.split('.');
    let current: Record<string, unknown> = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      const child = current[parts[i]];
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
    const parts = key.split('.');
    let current: Record<string, unknown> = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      const child = current[parts[i]];
      // Path doesn't exist (missing, null, or a non-object) — nothing to delete.
      // Guards the same `typeof null === 'object'` trap as set().
      if (child === null || typeof child !== 'object') return;
      current = child as Record<string, unknown>;
    }
    delete current[parts[parts.length - 1]];
    this.save();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        Object.assign(this.data, JSON.parse(raw));
      }
    } catch {
      // Use defaults on corrupt file
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
