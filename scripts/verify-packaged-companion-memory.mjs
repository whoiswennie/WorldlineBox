import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePackagedExecutable } from './release/lib.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ordinaryTitle = 'automatically records ordinary conversation, exposes sources and progress, rejects stale edits and forgets across restart';
const libraryTitle = 'binds the first companion entry to a real asset library and keeps readable notes, native recall and linked assets in sync across restart';
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const arguments_ = process.argv.slice(2);
if (arguments_.includes('--help')) {
  process.stdout.write('Usage: node scripts/verify-packaged-companion-memory.mjs [--package-root <out package or owned temporary directory>] [--grep ordinary|library|both]\nRuns real packaged ASAR acceptance with isolated test profiles. Does not build or install.\n');
  process.exit(0);
}
function option(name, fallback) {
  const inline = arguments_.find(argument => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = arguments_.indexOf(name);
  if (index < 0) return fallback;
  if (!arguments_[index + 1] || arguments_[index + 1].startsWith('--')) throw new Error(`Missing ${name} value.`);
  return arguments_[index + 1];
}
const selection = option('--grep', 'both');
if (!['ordinary', 'library', 'both'].includes(selection)) throw new Error('--grep must be ordinary, library or both.');
const packageRoot = path.resolve(option('--package-root', path.join(projectRoot, 'out', `WorldlineBox-${process.platform}-${process.arch}`)));
const output = path.join(projectRoot, 'artifacts', 'vcp-validation');
await mkdir(output, { recursive: true });
const reportFile = path.join(output, `packaged-companion-memory-${selection}.json`);
const log = createWriteStream(path.join(output, `packaged-companion-memory-${selection}.log`));
const report = { schema: 'worldlinebox.packaged-companion-memory', status: 'running', packageRoot, selection,
  actualPackagedAssertion: 'Each launch asserts app.isPackaged, app.asar and the exact isolated userData path.',
  userInstallationTouched: false, startedAt: new Date().toISOString(), tests: [], checksums: {}, steps: [] };
const contained = (root, target) => {
  const relative = path.relative(root, target);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function run(label, argv, env = {}) {
  process.stdout.write(`[packaged-companion] ${label}\n`);
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: projectRoot, env: { ...process.env, ...env }, shell: false,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => { process.stdout.write(bytes); log.write(bytes); });
    child.stderr.on('data', bytes => { process.stderr.write(bytes); log.write(bytes); });
    child.once('error', reject); child.once('close', code => resolve(code));
  });
  report.steps.push({ label, exitCode: status });
  if (status !== 0) throw new Error(`${label} exited with code ${status}.`);
}
try {
  const actualRoot = await realpath(packageRoot);
  const outRoot = path.join(await realpath(projectRoot), 'out'), temporaryRoot = await realpath(tmpdir());
  const temporaryRelative = path.relative(temporaryRoot, actualRoot);
  const ownedTemporary = contained(temporaryRoot, actualRoot) && /^worldlinebox-packaged-[^\\/]+(?:[\\/]|$)/u.test(temporaryRelative);
  if ((await lstat(packageRoot)).isSymbolicLink() || !contained(outRoot, actualRoot) && !ownedTemporary) {
    throw new Error('Package root must be a real project out directory or an owned worldlinebox-packaged-* temporary fixture. Installed application directories are refused.');
  }
  const executable = resolvePackagedExecutable(packageRoot);
  const resources = process.platform === 'darwin' ? path.join(packageRoot, 'WorldlineBox.app', 'Contents', 'Resources') : path.join(packageRoot, 'resources');
  report.executable = executable;
  await run('verify exact package resources', [path.join(projectRoot, 'scripts', 'verify-package.mjs')], {
    WORLDLINEBOX_PACKAGE_ROOT: packageRoot, WORLDLINEBOX_PACKAGE_PLATFORM: `${process.platform}-${process.arch}`,
  });
  for (const [name, file] of Object.entries({ executable, appAsar: path.join(resources, 'app.asar'),
    upstreamVcpManifest: path.join(resources, 'vcp-memory', 'upstream-manifest.json'), embeddingManifest: path.join(resources, 'embedding-models', 'manifest.json') })) {
    report.checksums[name] = await checksum(file);
  }
  const titles = selection === 'ordinary' ? [ordinaryTitle] : selection === 'library' ? [libraryTitle] : [ordinaryTitle, libraryTitle];
  report.tests = titles;
  const playwrightPackage = require('@playwright/test/package.json');
  const playwrightBin = typeof playwrightPackage.bin === 'string' ? playwrightPackage.bin : playwrightPackage.bin?.playwright;
  if (typeof playwrightBin !== 'string') throw new Error('Playwright CLI is unavailable.');
  const cli = path.resolve(path.dirname(require.resolve('@playwright/test/package.json')), playwrightBin);
  await run('real packaged memory acceptance', [cli, 'test', 'tests/e2e/companion-memory-library.test.ts', 'tests/e2e/companions.test.ts',
    '--grep', `(?:${titles.map(escapeRegex).join('|')})$`, '--workers=1', '--timeout=480000', '--global-timeout=1200000',
    '--reporter=line,json', '--output', path.join(output, `playwright-packaged-${selection}`)], {
    WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE: executable,
    WORLDLINEBOX_E2E_MEMORY_ASSET_EMBEDDING: '1',
    PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(output, `packaged-companion-playwright-${selection}.json`),
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.message || error); process.exitCode = 1;
  process.stderr.write(`[packaged-companion] ${report.error}\n`);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  await new Promise(resolve => log.end(resolve));
  process.stdout.write(`[packaged-companion] Report: ${reportFile}\n`);
}
