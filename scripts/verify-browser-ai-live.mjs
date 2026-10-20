import { build } from 'vite';
import { createRequire, builtinModules } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const key = process.env.WORLDLINEBOX_BROWSER_AI_LIVE_KEY;
delete process.env.WORLDLINEBOX_BROWSER_AI_LIVE_KEY;
if (!key) throw Error('Set WORLDLINEBOX_BROWSER_AI_LIVE_KEY explicitly for this paid, live API verification.');
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-browser-ai-live-'));
const outDir = path.join(root, 'app'); await mkdir(outDir);
await build({ configFile: false, logLevel: 'error', build: { outDir, emptyOutDir: false, target: 'node24', lib: { entry: path.resolve('tests/fixtures/browser-ai-live/main.ts'), formats: ['cjs'], fileName: () => 'main.cjs' },
  rollupOptions: { external: ['electron', ...builtinModules, ...builtinModules.map(name => 'node:' + name)] } }, resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main', 'jsnext'] } });
const require = createRequire(import.meta.url); const executable = require('electron');
const env = { ...process.env, WORLDLINEBOX_BROWSER_AI_LIVE_ROOT: root, WORLDLINEBOX_BROWSER_AI_LIVE_KEY: key }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [path.join(outDir, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', data => process.stdout.write(String(data).split(key).join('[redacted]')));
child.stderr.on('data', data => process.stderr.write(String(data).split(key).join('[redacted]')));
const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
const output = path.resolve('.tools/test-output/browser-ai'); await mkdir(output, { recursive: true });
const result = await readFile(path.join(root, 'result.json'), 'utf8').catch(() => '');
if (result) { if (result.includes(key)) throw Error('Refusing to publish a credential-bearing receipt.'); await copyFile(path.join(root, 'result.json'), path.join(output, 'live-deepseek.json')); }
process.exitCode = code ?? 1;
