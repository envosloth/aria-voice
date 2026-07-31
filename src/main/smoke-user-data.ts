import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Persistent stores are imported during main-module evaluation, so smoke mode
// must select its disposable userData directory before config.ts is evaluated.
if (process.env.ARIA_SMOKE === '1') {
  const requested = process.env.ARIA_SMOKE_USER_DATA?.trim();
  const userData = requested || fs.mkdtempSync(path.join(os.tmpdir(), 'aria-smoke-userdata-'));
  fs.mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  process.env.ARIA_SMOKE_USER_DATA = userData;
  console.log(`[ARIA_SMOKE] isolated userData: ${userData}`);
}
