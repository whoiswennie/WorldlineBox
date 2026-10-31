import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePackagedExecutable } from './release/lib.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const suites = { dossier: ['tests/e2e/companion-cognition-dossier.test.ts'], jobs: ['tests/e2e/companion-job-failure-management.test.ts'], recovery: ['tests/e2e/companion-recovery.test.ts'] };
const arguments_ = process.argv.slice(2);
if (arguments_.includes('--help')) {
  process.stdout.write('Usage: node scripts/verify-packaged-companion-memory.mjs [--package-root <out package or owned temporary directory>] [--suite dossier|jobs|recovery|all]\nRuns current cognition-v2 ASAR acceptance with isolated test profiles. Does not build or install.\n');
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
if (arguments_.some(argument => argument === '--grep' || argument.startsWith('--grep='))) throw new Error('The retired editable-memory suites have been replaced. Select --suite dossier|jobs|recovery|all.');
const selection = option('--suite', 'all');
if (selection !== 'all' && !Object.hasOwn(suites, selection)) throw new Error('--suite must be dossier, jobs, recovery or all.');
const selectedSuites = selection === 'all' ? Object.keys(suites) : [selection];
const files = selectedSuites.flatMap(name => suites[name]);
const packageRoot = path.resolve(option('--package-root', path.join(projectRoot, 'out', `WorldlineBox-${process.platform}-${process.arch}`)));
const startedAtMs = Date.now();
const evidenceRoot = path.join(projectRoot, 'artifacts', 'cognition-validation');
const output = path.join(evidenceRoot, 'packaged', new Date(startedAtMs).toISOString().replace(/[-:.]/gu, '').replace(/\d{3}Z$/u, 'Z') + '-' + process.pid);
await mkdir(output, { recursive: true });
const reportFile = path.join(output, 'report.json');
const log = createWriteStream(path.join(output, 'execution.log'));
const report = { schema: 'worldlinebox.packaged-companion-cognition-v2', status: 'running', packageRoot, selection,
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
  report.tests = files;
  const playwrightPackage = require('@playwright/test/package.json');
  const playwrightBin = typeof playwrightPackage.bin === 'string' ? playwrightPackage.bin : playwrightPackage.bin?.playwright;
  if (typeof playwrightBin !== 'string') throw new Error('Playwright CLI is unavailable.');
  const cli = path.resolve(path.dirname(require.resolve('@playwright/test/package.json')), playwrightBin);
  await run('real packaged cognition acceptance', [cli, 'test', ...files,
    '--workers=1', '--timeout=300000', '--global-timeout=1200000',
    '--reporter=line,json', '--output', path.join(output, 'playwright')], {
    WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE: executable,
    WORLDLINEBOX_E2E_MEMORY_ASSET_EMBEDDING: '1',
    PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(output, 'playwright.json'),
  });
  const proofFiles = { dossier: ['ui/packaged-cognition-creation-build-proof.json', 'ui/packaged-actual-context-transport-proof.json'],
    jobs: ['packaged-fault-manager-electron-proof.json'], recovery: ['packaged-recovery-electron-ui-proof.json'] };
  report.proofs = [];
  for (const relative of selectedSuites.flatMap(name => proofFiles[name])) {
    const file = path.join(evidenceRoot, relative), proof = JSON.parse(await readFile(file, 'utf8')), build = proof.build ?? proof;
    if ((await stat(file)).mtimeMs < startedAtMs || build.isPackaged !== true || build.appAsarHash !== report.checksums.appAsar || build.isolatedProfile !== true) {
      throw new Error('The selected suite did not produce a fresh proof of the exact packaged ASAR: ' + relative);
    }
    report.proofs.push({ path: relative, appAsarHash: build.appAsarHash, companionWorkerHash: build.companionWorkerHash });
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.message || error); process.exitCode = 1;
  process.stderr.write(`[packaged-companion] ${report.error}\n`);
} finally {
  // Preserve every run's screenshots and receipts, including failed attempts.
  for (const directory of ['', 'ui']) {
    for (const entry of await readdir(path.join(evidenceRoot, directory), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.startsWith('packaged-')) continue;
      const source = path.join(evidenceRoot, directory, entry.name);
      try {
        if ((await stat(source)).mtimeMs < startedAtMs) continue;
        const destination = path.join(output, 'evidence', directory, entry.name);
        await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination);
      } catch (error) {
        (report.archiveErrors ??= []).push({ source, error: String(error.message || error) });
        report.status = 'failed'; process.exitCode = 1;
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  await new Promise(resolve => log.end(resolve));
  process.stdout.write(`[packaged-companion] Report: ${reportFile}\n`);
}
