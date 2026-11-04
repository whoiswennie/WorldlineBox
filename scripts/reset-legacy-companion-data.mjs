import { readFile, mkdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const planFile = path.resolve(argument('--plan') || path.join(projectRoot, 'artifacts', 'superagent-bot-development', 'legacy-reset-plan.json'));
const bytes = await readFile(planFile), plan = JSON.parse(bytes);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
if (!path.isAbsolute(plan.userData) || !path.isAbsolute(plan.library) || !same(plan.newRoot, path.join(plan.userData, 'companion-bot-v2'))
  || !same(plan.locator.path, path.join(plan.userData, 'companion-library.json'))) throw new Error('Unexpected cleanup profile/root mapping');
const library = await realpath(plan.library);
const allowed = ['.worldlinebox/companions', '伙伴记忆', '.worldlinebox/companions-recovery-authority.sqlite',
  '.worldlinebox/companions-recovery-authority.sqlite-wal', '.worldlinebox/companions-recovery-authority.sqlite-shm', '.worldlinebox/companions-recovery-enrollment.json']
  .map(relative => path.resolve(library, relative));
if (!plan.targets.every(target => allowed.some(file => same(file, target.path)))) throw new Error('Cleanup plan contains an unowned target');
let journal;
try { journal = JSON.parse(await readFile(path.join(plan.newRoot, 'legacy-reset.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const recoverable = journal?.version === 3 && same(journal.libraryPath || '', library) && journal.locatorSha256 === plan.locator.sha256
  && journal.targets.every(target => allowed.some(file => same(file, target)));
let locator;
try { locator = await readFile(plan.locator.path); }
catch (error) { if (error.code !== 'ENOENT' || !recoverable) throw error; }
if (locator) {
  if (createHash('sha256').update(locator).digest('hex') !== plan.locator.sha256) throw new Error('Locator changed since inspection');
  const located = JSON.parse(locator);
  if (!same(await realpath(located.libraryPath), library)) throw new Error('Locator selected a different library');
}
for (const target of plan.targets) {
  try { if (!same(await realpath(target.path), target.path)) throw new Error('Cleanup target resolves through a link'); }
  catch (error) { if (error.code !== 'ENOENT' || !recoverable || !journal.targets.some(old => same(old, target.path))) throw error; }
}
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ apply: false, validatedPlan: planFile, library, targets: plan.targets, preserved: plan.preserve }, null, 2)); process.exit(0);
}
if (process.platform === 'win32') {
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(WorldlineBox|electron)$' } | Select-Object Id,ProcessName) | ConvertTo-Json -Compress"],
  { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) throw new Error('Could not verify legacy application process ownership');
  if (probe.stdout.trim() && probe.stdout.trim() !== '[]') throw new Error('Close WorldlineBox/Electron before explicitly resetting its old data: ' + probe.stdout.trim());
}
const signature = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const output = path.join(projectRoot, 'artifacts', 'superagent-bot-development', 'legacy-reset-' + signature);
const bundle = path.join(projectRoot, '.tools', 'legacy-companion-reset', signature);
await mkdir(output, { recursive: true }); await mkdir(bundle, { recursive: true });
const externals = ['electron', 'better-sqlite3', 'sqlite-vec', 'koffi', 'sharp', 'exifr', '@napi-rs/canvas'];
await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: externals },
  build: { ssr: path.join(projectRoot, 'tests/fixtures/legacy-bot-reset/main.ts'), outDir: bundle, target: 'node24',
    rollupOptions: { external: externals, output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: externals },
  build: { ssr: path.join(projectRoot, 'src/worker/index.ts'), outDir: bundle, emptyOutDir: false, target: 'node24',
    rollupOptions: { external: externals, output: { format: 'cjs', entryFileNames: 'library_worker.js' } } } });
const require = createRequire(path.join(projectRoot, 'package.json'));
const electron = require('electron'); if (typeof electron !== 'string' || !existsSync(electron)) throw new Error('Electron executable unavailable');
const env = { ...process.env, WORLDLINEBOX_LEGACY_RESET_PLAN: planFile, WORLDLINEBOX_LEGACY_RESET_OUTPUT: output,
  WORLDLINEBOX_LEGACY_RESET_APPLY: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(bundle, 'main.cjs')], { cwd: projectRoot, env, windowsHide: true, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
if (code !== 0) throw new Error(`Legacy reset failed (${code}); inspect ${output}. No alternate deletion method will be attempted.`);
console.log(JSON.stringify({ completed: true, report: path.join(output, 'result.json') }));
