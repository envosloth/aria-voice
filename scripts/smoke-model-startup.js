#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const code = ts.transpile(ast.statements.filter((s) => ts.isFunctionDeclaration(s) &&
  ['applySidecarConfig', 'ensureSidecar'].includes(s.name.text)).map((s) => s.getText(ast)).join('\n'),
  { target: ts.ScriptTarget.ES2022 });
async function main() {
  for (const name of ['stt', 'tts']) {
    for (const mode of ['reload', 'lazy']) {
      for (const available of [true, false]) {
        const events = [];
        const ctx = { console, sidecarStarts: new Map(), lazyStarted: new Set(mode === 'reload' ? [name] : []),
          applyConfigToEnv() {}, ensureModelsReady: async () => { events.push('models'); return available; },
          supervisor: { start: async () => events.push('start'), restart: async () => events.push('restart'),
            waitForReady: async () => events.push('ready') } };
        vm.createContext(ctx); vm.runInContext(code, ctx);
        let rejected = false;
        try { await ctx[mode === 'reload' ? 'applySidecarConfig' : 'ensureSidecar'](name); }
        catch { rejected = true; }
        assert.equal(events[0], 'models', `${name}/${mode} must provision before launch`);
        if (!available) {
          assert.deepEqual(events, ['models']);
          if (mode === 'lazy') assert.ok(rejected, 'missing lazy models must surface failure');
        } else assert.ok(events.includes(mode === 'reload' ? 'restart' : 'start'));
        console.log(`PASS ${name}/${mode}/models-${available}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
