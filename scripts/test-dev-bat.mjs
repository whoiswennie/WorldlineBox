#!/usr/bin/env node
/** Accept the actual 02 batch entrypoint. This intentionally starts Forge only when explicitly run. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, Module } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, lstat, realpath, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { findFreeTcpPort } from './free-port.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(projectRoot, 'package.json'));
const batch = path.join(projectRoot, '02-Start-Development.bat');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const masked = value => String(value).replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
  .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  .replace(/((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]');

async function ordinary(file, directory = false) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) throw new Error(`Acceptance path must be ordinary: ${file}`);
  return info;
}
async function preflight() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This acceptance runner requires Windows x64.');
  if (/[\r\n\0%"]/.test(batch)) throw new Error('The actual batch path cannot be safely passed to cmd.exe.');
  await ordinary(batch); await ordinary(path.join(projectRoot, 'scripts', 'windows.ps1'));
  const version = (await readFile(path.join(projectRoot, '.nvmrc'), 'utf8')).trim();
  const setup = await json(path.join(projectRoot, '.tools', 'setup-state.json'));
  const lockHash = createHash('sha256').update(await readFile(path.join(projectRoot, 'package-lock.json'))).digest('hex');
  if (setup.nodeVersion !== version || setup.lockHash !== lockHash) throw new Error('Prepare the current setup-state first; acceptance must not trigger npm ci or a native rebuild.');
  await ordinary(path.join(projectRoot, '.tools', `node-v${version}-win-x64`, 'node.exe'));
  await ordinary(path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe'));
  const dev = await readFile(path.join(projectRoot, 'scripts', 'dev-start.mjs'), 'utf8');
  if (!/function cleanupDevTree\(\)\s*\{[^}]*WORLDLINEBOX_E2E[^}]*killStaleWorldlineBoxDevProcesses/.test(dev)) throw new Error('The E2E exit cleanup guard is required before batch acceptance can run.');
  const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8');
  if (!main.includes('WORLDLINEBOX_E2E_REMOTE_DEBUGGING_PORT')) throw new Error('Add the E2E-only loopback remote debugging hook before running acceptance.');
  return { version, lockHash };
}
function loadWindowsJobHelper() {
  // Reuse the production supervisor without building or changing .vite.
  const source = require('node:fs').readFileSync(path.join(projectRoot, 'src', 'main', 'dsh', 'windows-job.ts'), 'utf8');
  const ts = require('typescript');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const filename = path.join(projectRoot, 'src', 'main', 'dsh', 'windows-job.acceptance.cjs');
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(compiled, filename); return module.exports.attachProcessJob;
}
async function waitUntil(operation, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await operation(); if (value) return value;
    await delay(200);
  }
  throw new Error(`Acceptance timed out: ${label}`);
}
async function readSessionLogs(userData) {
  const directory = path.join(userData, 'logs');
  const entries = await readdir(directory).catch(() => []); let text = '';
  for (const name of entries.filter(name => /^worldlinebox-.*\.log$/.test(name)).sort()) {
    const file = path.join(directory, name); const info = await ordinary(file);
    if (info.size > 8 * 1024 * 1024) throw new Error('Acceptance session log exceeds its limit.');
    text += await readFile(file, 'utf8');
  }
  return text;
}
async function cleanupTemporary(temporaryRoot) {
  const absolute = path.resolve(temporaryRoot), parent = await realpath(tmpdir());
  if (!same(path.dirname(await realpath(absolute)), parent) || !path.basename(absolute).startsWith('worldlinebox-dev-bat-') || !inside(parent, absolute)) throw new Error('Refusing an unexpected acceptance cleanup target.');
  await ordinary(absolute, true); await rm(absolute, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
async function launcherState(page) {
  const result = await page.evaluate(() => globalThis.worldlinebox.dshLauncher.request({ type: 'state' }));
  if (!result.ok || !result.state) throw new Error('The real preload DSH state IPC did not initialize.');
  return result.state;
}
async function processFootprint(rootPid) {
  const code = `$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize); $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${Number(rootPid)}); do { $changed=$false; foreach($p in $all) { if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) {$changed=$true} } } while($changed); @($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object { @{pid=[int]$_.ProcessId; name=$_.Name; workingSetBytes=[long]$_.WorkingSetSize} }) | ConvertTo-Json -Compress`;
  const child = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command', code], { windowsHide: true });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', status => status === 0 ? resolve() : reject(new Error('Resource measurement failed.'))); });
  return JSON.parse(output.replace(/^\uFEFF/, '').trim());
}
function childEnvironment(tempRoot, cdpPort, vitePort) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|DSH_.*|DEEPSEEK_.*|OPENAI_.*|ANTHROPIC_.*|GEMINI_.*|GOOGLE_API_KEY|AZURE_OPENAI_.*|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|NPM_TOKEN|NPM_CONFIG_.*|PNPM_.*|PYTHONHOME|PYTHONPATH|PSModulePath)$/i.test(key) || key.startsWith('WORLDLINEBOX_')) delete env[key];
  return { ...env, WORLDLINEBOX_BATCH_NO_PAUSE: '1', WORLDLINEBOX_E2E: '1',
    WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(tempRoot, 'user-data'),
    WORLDLINEBOX_USER_DATA_PATH: path.join(tempRoot, 'user-data'),
    WORLDLINEBOX_E2E_CREATE_PARENT_PATH: tempRoot, WORLDLINEBOX_E2E_ISOLATED: '1',
    WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_REMOTE_DEBUGGING_PORT: String(cdpPort),
    WORLDLINEBOX_E2E_STARTUP_SCREEN: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1',
    ...(process.argv.includes('--hardware-gpu') ? { WORLDLINEBOX_E2E_ENABLE_HARDWARE_GPU: '1' } : {}),
    WORLDLINEBOX_VITE_PORT: String(vitePort), VcpkgEnabled: 'false',
    PSModulePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
}
async function run() {
  const setup = await preflight();
  const launchStartedAt = Date.now();
  if (process.argv.includes('--check')) { console.log(JSON.stringify({ checked: true, batch, ...setup })); return; }
  if (process.argv.some(arg => arg.startsWith('--') && !['--check', '--diagnose', '--hardware-gpu'].includes(arg))) throw new Error('Usage: node scripts/test-dev-bat.mjs [--check|--diagnose|--hardware-gpu]');
  const toolsRoot = path.join(projectRoot, '.tools'); await ordinary(toolsRoot, true);
  const reportsRoot = path.join(toolsRoot, 'dev-bat-acceptance');
  await mkdir(reportsRoot, { recursive: true }); await ordinary(reportsRoot, true);
  const report = path.join(reportsRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  await mkdir(report); await ordinary(report, true);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'worldlinebox-dev-bat-'));
  const userData = path.join(temporaryRoot, 'user-data'); const root = path.join(userData, 'dsh-launcher');
  const cdpPort = await findFreeTcpPort(32_000); const vitePort = await findFreeTcpPort(cdpPort + 1);
  const attach = loadWindowsJobHelper(); let child, job, browser, page, verifiedOwnedApp = false;
  let stdout = '', stderr = '', result, failure, ownedTreeStopped = false;
  const rendererErrors = [], failedRequests = [], resourceRequests = [];
  const capture = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-8 * 1024 * 1024);
  try {
    // cmd first waits for stdin: no batch descendant can spawn until its Job is attached.
    const cmd = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    child = spawn(cmd, ['/d', '/q', '/k'], { cwd: projectRoot, env: childEnvironment(temporaryRoot, cdpPort, vitePort),
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { stdout = capture(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = capture(stderr, chunk); });
    let launchError; child.once('error', error => { launchError = error; });
    job = attach(child, { closeOnExit: false });
    if (!job) throw new Error('The owned batch process needs a Windows Job.');
    child.stdin.write(`@call "${batch}"\r\n@exit /b %ERRORLEVEL%\r\n`);
    console.log(`[dev-bat-acceptance] Actual 02 batch started; logs: ${report}`);
    await waitUntil(async () => {
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`The actual batch exited before CDP was ready (${child.exitCode}).`);
      try { const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok) return false; const metadata = await response.json(); return typeof metadata.webSocketDebuggerUrl === 'string';
      } catch { return false; }
    }, 'Forge/Electron CDP endpoint');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 15_000 });
    page = await waitUntil(async () => browser.contexts().flatMap(context => context.pages()).find(candidate => {
      try { const url = new URL(candidate.url()); return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port === String(vitePort); } catch { return false; }
    }), 'the actual Forge renderer');
    page.setDefaultTimeout(30_000);
    page.on('pageerror', error => rendererErrors.push(masked(error.stack ?? error.message)));
    page.on('requestfailed', request => failedRequests.push({ url: request.url(), failure: request.failure() }));
    page.on('request', request => { if (resourceRequests.length < 10_000) resourceRequests.push({ url: request.url(), at: Date.now() - launchStartedAt }); });
    await expect(page.locator('.application-navigation')).toBeVisible({ timeout: process.argv.includes('--diagnose') ? 180_000 : 60_000 });
    console.log(`[dev-bat-acceptance] Home is usable after ${Date.now() - launchStartedAt} ms.`);
    const launchDurationMs = Date.now() - launchStartedAt;
    const homeLogs = await waitUntil(async () => { const logs = await readSessionLogs(userData); return logs.includes('main.window.mount-verified') ? logs : false; }, 'painted application shell', 10_000);
    expect(homeLogs).not.toContain('"scope":"worker.spawn"');
    expect(homeLogs).not.toContain('"scope":"companions.activated"');
    const homeResources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    expect(homeResources.some(url => /\/src\/renderer\/(?:App|companions\/Companions|launcher\/(?:LauncherTerminal|TerminalSurface))\.tsx(?:\?|$)|\/world-engine\.ts(?:\?|$)|(?:\/|_)xterm[_/]/.test(url))).toBe(false);
    expect(homeResources.some(url => /fontsource|harmonyos-sans/.test(url))).toBe(false);
    const homeProcesses = await processFootprint(child.pid);
    await writeFile(path.join(report, 'home-startup.json'), JSON.stringify({ launchDurationMs, homeResources, homeProcesses }, null, 2));
    expect(stdout).toContain('No dependency installation or native rebuild will run.');
    expect(stdout + stderr).not.toMatch(/\[rebuild-native\]|Installing locked npm dependencies|Building module:|> .* rebuild:native/);
    const initial = await launcherState(page);
    if (!same(initial.rootPath, root)) throw new Error('CDP connected to a different application profile; no UI mutation is allowed.');
    verifiedOwnedApp = true;
    expect(initial.supported).toBe(true); expect(initial.runtimes).toHaveLength(0); expect(initial.instances).toHaveLength(0);
    expect(initial.network?.settings.proxyMode).toBe('system'); expect(initial.network?.settings.npmRegistry).toBe('https://registry.npmjs.org');
    expect(inside(root, initial.cli.commandPath)).toBe(true);
    expect(await page.evaluate(() => ({ node: typeof globalThis.process, require: typeof globalThis.require }))).toEqual({ node: 'undefined', require: 'undefined' });
    const dsh = page.locator('[data-application-module="dsh"]');
    await expect(dsh).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-application-module]').first()).toHaveAttribute('data-application-module', 'dsh');
    await expect(page.locator('[data-application-view="assets"]')).toBeHidden();
    await expect(page.locator('.launcher-navigation').getByRole('button', { name: '网络设置', exact: true })).toHaveCount(0);
    await page.locator('[data-application-module="network"]').click();
    await expect(page.locator('[data-application-network]')).toBeVisible();
    const globalNetwork = await page.evaluate(() => globalThis.worldlinebox.network.request({ type: 'state' }));
    expect(globalNetwork.ok && globalNetwork.state?.settings.proxyMode).toBe('system');
    await page.getByRole('switch', { name: '启用代理' }).click();
    await expect.poll(async () => {
      const response = await page.evaluate(() => globalThis.worldlinebox.network.request({ type: 'state' }));
      return response.ok ? response.state?.settings.proxyMode : 'failed';
    }).toBe('direct');
    expect((await launcherState(page)).network?.settings.proxyMode).toBe('direct');
    await page.screenshot({ path: path.join(report, 'global-network.png') });
    await page.getByRole('switch', { name: '启用代理' }).click();
    await expect.poll(async () => (await launcherState(page)).network?.settings.proxyMode).toBe('system');
    await dsh.click();
    await expect(dsh).toHaveAttribute('aria-current', 'page');
    const settings = page.locator('.application-navigation-footer').getByRole('button', { name: '设置', exact: true });
    for (const theme of ['亮色', '暗色']) {
      await settings.click(); const dialog = page.getByRole('dialog', { name: '通用设置', exact: true });
      await expect(dialog).toBeVisible(); await expect(dsh).toHaveAttribute('aria-current', 'page');
      await dialog.getByRole('tab', { name: '外观', exact: true }).click();
      await dialog.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
      const radio = dialog.getByRole('radio', { name: theme, exact: true }); await radio.click(); await expect(radio).toBeChecked();
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(dsh).toHaveAttribute('aria-current', 'page');
      await page.screenshot({ path: path.join(report, theme === '亮色' ? 'development-light.png' : 'development-dark.png') });
    }
    const logs = await waitUntil(async () => { const text = await readSessionLogs(userData); return text.includes('main.window.mount-verified') && text.includes('main.portable-tools') ? text : false; }, 'native mount and portable tool initialization', 30_000);
    const entries = logs.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    expect(entries.some(entry => entry.scope === 'main.user-data' && same(entry.context?.path ?? '.', userData) && entry.context?.mode === 'e2e')).toBe(true);
    expect(entries.find(entry => entry.scope === 'main.portable-tools.deferred')?.level).toBe('info');
    expect(entries.some(entry => entry.scope === 'main.window.mount-failed' || entry.scope === 'dsh.launcher.initialization' && entry.level === 'error')).toBe(false);
    const final = await launcherState(page); expect(final.instances).toHaveLength(0); expect(final.runtimes).toHaveLength(0);
    await writeFile(path.join(report, 'launcher-state.json'), JSON.stringify(final, null, 2));
    result = { ok: true, batch, setup, cdpPort, vitePort, cmdPid: child.pid, rendererUrl: page.url(), launchDurationMs,
      dependencyInstallation: false, nativeRebuild: false,
      firstModule: 'dsh', settingsPreserveModule: true, themes: ['light', 'dark'], portableToolsOnDemand: true,
      inactiveModulesUnloaded: true, noStartupDataWorkers: true, homeProcesses,
      nativePreloadIpc: true, globalNetworkRail: true, globalNetworkLiveToggle: true, isolatedUserData: userData, runtimeInstalls: 0, modelCalls: 0 };
  } catch (error) { failure = error; }
  finally {
    if (page && !page.isClosed()) {
      const snapshot = await page.evaluate(() => ({ readyState: globalThis.document.readyState,
        root: globalThis.document.getElementById('root')?.innerHTML.slice(0, 2000), hasBridge: !!globalThis.worldlineboxStartup,
        resources: performance.getEntriesByType('resource').length,
        pendingScripts: [...globalThis.document.scripts].map(script => script.src),
        resourceTail: performance.getEntriesByType('resource').slice(-25).map(entry => ({ name: entry.name, duration: entry.duration })),
      })).catch(error => ({ error: masked(error.message) }));
      await writeFile(path.join(report, 'renderer-diagnostics.json'), JSON.stringify({ snapshot, rendererErrors, failedRequests, resourceRequests }, null, 2));
    }
    if (verifiedOwnedApp && page && !page.isClosed()) await page.evaluate(() => globalThis.worldlinebox.shell.windowControl('close')).catch(() => undefined);
    if (job) {
      try { await job.waitForEmpty(10_000); ownedTreeStopped = true; }
      catch { job.terminate(); try { await job.waitForEmpty(10_000); ownedTreeStopped = true; } catch (error) { failure ??= error; } }
      job.close();
    } else if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); ownedTreeStopped = true; }
    else { ownedTreeStopped = true; }
    await browser?.close().catch(() => undefined);
    await writeFile(path.join(report, 'forge-stdout.log'), masked(stdout)); await writeFile(path.join(report, 'forge-stderr.log'), masked(stderr));
    const logs = await readSessionLogs(userData).catch(() => ''); await writeFile(path.join(report, 'native-session.log'), masked(logs));
    if (ownedTreeStopped) {
      await cleanupTemporary(temporaryRoot).catch(error => { failure ??= error; });
    }
    await writeFile(path.join(report, 'result.json'), JSON.stringify(failure
      ? { ok: false, error: masked(failure), batch, setup, cdpPort, vitePort, ownedTreeStopped, temporaryRoot }
      : { ...result, ownedTreeStopped, temporaryDataRemoved: true }, null, 2));
  }
  if (failure) throw new Error(`Actual 02 batch acceptance failed; inspect ${report}`, { cause: failure });
  console.log(`[dev-bat-acceptance] Passed; evidence retained at ${report}`);
}
await run().catch(error => { console.error(masked(error), error.cause ? masked(error.cause) : ''); process.exitCode = 1; });
