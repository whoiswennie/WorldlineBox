#!/usr/bin/env node
// Keep the native better-sqlite3 addon aligned with the Electron runtime used
// by Worker/E2E tests. Host Node and Electron intentionally expose different
// NODE_MODULE_VERSION values; probe first so the normal path does not rebuild
// on every test invocation. Development uses --check-only: repairs belong to setup.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = require('electron');

process.env.VcpkgEnabled = 'false';

if (typeof electronPath !== 'string') {
  throw new TypeError('The local electron package did not resolve to an executable path.');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
      ...options,
      env: { ...process.env, ...options.env },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(false);
        return;
      }
      resolve(code === 0);
    });
  });
}

// Construct an in-memory database instead of merely requiring the package:
// better-sqlite3 loads its native addon lazily when Database is instantiated.
//
// FTS5 is part of WorldlineBox's database contract, not an optional extension. A
// native module linked against a system SQLite can still open a database while
// silently omitting FTS5 (notably after a vcpkg/MSBuild hijack on Windows), so
// checking only `new Database()` is insufficient. The probe must exercise the
// same virtual-table capability used by the library search index.
const electronReady = await run(
  electronPath,
  [
    '-e',
    [
      "const Database = require('better-sqlite3');",
      "const db = new Database(':memory:');",
      "db.exec('CREATE VIRTUAL TABLE worldlinebox_native_probe USING fts5(value)');",
      'db.close();',
      "if (process.platform === 'win32') {",
      "const { loadNativeModule } = require('node-pty/lib/utils');",
      "loadNativeModule('conpty'); loadNativeModule('conpty_console_list');",
      "} else { require('node-pty'); }",
    ].join(''),
  ],
  {
    // A mismatch is expected on the first invocation after a host-Node
    // install/rebuild; keep Electron's native stack trace out of normal logs.
    stdio: 'ignore',
    timeout: 15_000,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  },
);

if (electronReady) {
  console.log('[ensure-native] Electron SQLite/FTS5 and terminal native modules are ready.');
  process.exit(0);
}

if (process.argv.includes('--check-only')) {
  console.error('[ensure-native] Native runtime is missing or incompatible. Run 01-Setup-Environment.bat (or npm run rebuild:native) to repair it. Development startup will not rebuild or install packages.');
  process.exit(1);
}

console.log('[ensure-native] Electron ABI or FTS5 probe failed; rebuilding better-sqlite3 for Electron...');
const rebuilt = await run(process.execPath, [path.join(repoRoot, 'scripts', 'rebuild-native.mjs')]);
if (!rebuilt) {
  process.exitCode = 1;
}
