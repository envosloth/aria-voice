#!/usr/bin/env node
/* Window/launcher icon identity (the top-left icon must match the shortcut).
 *
 * On Wayland/X11 the compositor picks a window's icon by matching its app_id /
 * WM_CLASS against a .desktop file's StartupWMClass. Electron's default class
 * is "electron", which matches nothing, so the frame fell back to a generic
 * icon while the launcher showed ARIA's. The fix is one class name everywhere:
 * the app sets it (app.setName + --class), the launcher passes it, and the
 * .desktop file declares it. All three are asserted here, plus the window icon
 * file resolving to the same asset the launcher uses.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
const launcher = path.join(os.homedir(), '.local', 'bin', 'aria-launch');
const desktopFile = path.join(os.homedir(), '.local', 'share', 'applications', 'aria-voice-dev.desktop');
let pass = true;
const check = (n, c, d) => { if (!c) pass = false; console.log(`[${n}] ${c ? 'PASS' : 'FAIL'}${d ? ' — ' + d : ''}`); };

check('main-sets-window-class', main.includes("const ARIA_WM_CLASS = 'aria-voice'") && main.includes("app.setName('ARIA')"));
check('main-sets-desktop-name', /setDesktopName/.test(main) && /\$\{ARIA_WM_CLASS\}\.desktop/.test(main));
check('window-uses-icon', /icon: appIconPath\(\)/.test(main) && /function appIconPath/.test(main));
const icon = path.join(root, 'assets', 'icon.png');
check('icon-asset-exists', fs.existsSync(icon));
const launcherIcon = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'aria-voice.png');
if (fs.existsSync(launcherIcon)) {
  const a = fs.readFileSync(icon); const b = fs.readFileSync(launcherIcon);
  check('window-icon-matches-launcher', a.length === b.length && a.equals(b));
} else {
  console.log('[window-icon-matches-launcher] SKIP — launcher icon not installed in this user\'s icon theme');
}
if (fs.existsSync(desktopFile)) {
  const d = fs.readFileSync(desktopFile, 'utf8');
  check('desktop-declares-wm-class', /StartupWMClass=aria-voice/.test(d));
  check('desktop-icon-name', /Icon=aria-voice/.test(d));
} else {
  console.log('[desktop-declares-wm-class] SKIP — no dev .desktop entry for this user');
}
if (fs.existsSync(launcher)) {
  const l = fs.readFileSync(launcher, 'utf8');
  check('launcher-passes-class', /--class=aria-voice/.test(l));
} else {
  console.log('[launcher-passes-class] SKIP — no dev launcher script');
}
console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
