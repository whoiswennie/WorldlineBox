// Isolated runtime instrumentation only. A deadline exit is diagnostic failure,
// never a successful graceful-shutdown or production-profile acceptance.
import { _electron as electron } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acceptanceProcesses, removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

const deferredQuit = process.argv.includes('--defer-quit');
const offscreen = process.argv.includes('--offscreen'), primeWindow = process.argv.includes('--prime-window');
const removeEffectsDisposer = process.argv.includes('--remove-effects-disposer');
const finalFixed = process.argv.includes('--final-fixed');
if (finalFixed && (deferredQuit || offscreen || primeWindow || removeEffectsDisposer)) throw new Error('Final fixed verification cannot combine runtime workaround flags.');
const executablePath = path.resolve(process.argv.slice(2).find(value => !value.startsWith('--')) ?? 'out/WorldlineBox-win32-x64/WorldlineBox.exe');
const output = path.resolve('artifacts/superagent-bot-development/packaged-shutdown-diagnostic');
await stat(executablePath); const asar = await stat(path.join(path.dirname(executablePath), 'resources', 'app.asar'));
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-bot-real-shutdown-'));
const profile = path.join(root, 'electron-profile'); await mkdir(profile);
await writeFile(path.join(root, '.worldlinebox-acceptance.json'), JSON.stringify({ kind: 'shutdown-diagnostic', ownerPid: process.pid }));
const reportPath = path.join(output, finalFixed ? 'final-fixed.json' : removeEffectsDisposer ? 'effects-disposer-removed.json' : offscreen ? 'offscreen-quit.json' : primeWindow ? 'primed-window-quit.json' : deferredQuit ? 'deferred-quit.json' : 'result.json');
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => typeof value === 'string'
  && !name.startsWith('WORLDLINEBOX_E2E') && !['ELECTRON_RUN_AS_NODE', 'WORLDLINEBOX_USER_DATA_PATH', 'WORLDLINEBOX_ALLOW_MULTI_INSTANCE'].includes(name)));
Object.assign(env, { WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
  WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_ENABLE_HARDWARE_GPU: '1' });
if (offscreen) env.WORLDLINEBOX_E2E_PERF_OFFSCREEN = '1';
let application, ownedProcess, mainPid, verified = false; const stderrMarkers = new Set();
function monitorMainProcess(pid) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('The diagnostic requires a valid Windows Main PID.');
  const command = `$shutdownMain = [System.Diagnostics.Process]::GetProcessById(${pid}); [void]$shutdownMain.Handle; [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); if ($shutdownMain.WaitForExit(30000)) { [Console]::Out.WriteLine(('exit:' + $shutdownMain.ExitCode)) } else { [Console]::Out.WriteLine('timeout') }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new Error('Main OS process monitor did not acquire its handle.')), 5000);
  child.stdout.on('data', bytes => { output += String(bytes); if (output.includes('ready')) { clearTimeout(timer); readyResolve(); } });
  const result = new Promise(resolve => {
    child.once('error', () => { clearTimeout(timer); readyReject(new Error('Could not open Main OS process monitor.')); resolve({ observedExit: false }); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (!output.includes('ready')) readyReject(new Error('Main OS process monitor exited before acquiring its handle.'));
      const actual = /exit:(-?\d+)/u.exec(output);
      resolve({ observedExit: actual !== null, mainExitCode: actual ? Number(actual[1]) : null, monitorExitCode: code });
    });
  });
  return { ready, result };
}
try {
  application = await electron.launch({ executablePath, args: [], cwd: path.dirname(executablePath), env, timeout: 45000 });
  ownedProcess = application.process();
  ownedProcess.stderr?.on('data', chunk => {
    for (const marker of ['Waiting for the debugger to disconnect', 'Debugger attached', 'Debugger listening']) if (String(chunk).includes(marker)) stderrMarkers.add(marker);
  });
  const page = await application.firstWindow();
  const state = await page.evaluate(async () => {
    const result = await globalThis.worldlinebox.companionBot.request({ type: 'state' });
    return { ok: result.ok, companions: result.snapshot?.companions.length, engine: result.snapshot?.runtime.engine };
  });
  if (!state.ok || state.engine !== 'worldlinebox') throw new Error('New App state did not initialize.');
  const ownership = await application.evaluate(({ app, BrowserWindow }, input) => {
    const nodeRequire = typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule);
    const fs = nodeRequire('node:fs'), path = nodeRequire('node:path'), modules = nodeRequire('node:module')._cache;
    const actualProfile = app.getPath('userData'), actualApp = app.getAppPath(), pid = process.pid;
    if (path.resolve(actualProfile).toLowerCase() !== input.profile.toLowerCase() || !app.isPackaged
      || !actualApp.toLowerCase().startsWith(path.join(path.dirname(input.executablePath), 'resources', 'app.asar').toLowerCase())) throw new Error('Diagnostic ownership mismatch.');
    if (BrowserWindow.getAllWindows().some(window => window.isVisible())) throw new Error('Diagnostic window was visible.');
    const report = { kind: 'isolated-packaged-shutdown-diagnostic', productionProfile: false, chatMessagesSubmitted: 0,
      modelCallsRequested: 0, delegatedTasksRequested: 0, pid, profile: actualProfile, appPath: actualApp,
      diagnosticForcedExit: false, gracefulShutdownVerified: false, wrapped: [], events: [] };
    let serial = 0;
    const record = (type, extra = {}) => {
      if (report.events.length < 1500) report.events.push({ sequence: ++serial, at: Date.now(), type, ...extra });
      fs.writeFileSync(input.reportPath, JSON.stringify(report, null, 2));
    };
    const observed = new Set();
    for (const module of Object.values(modules)) {
      const filename = module?.filename;
      if (typeof filename !== 'string' || !filename.toLowerCase().startsWith(actualApp.toLowerCase() + path.sep + '.vite' + path.sep + 'build' + path.sep)) continue;
      const exports = typeof module.exports === 'function' ? [module.exports] : Object.values(module.exports ?? {});
      for (const candidate of exports) {
        if (typeof candidate !== 'function' || !candidate.prototype || observed.has(candidate.prototype)) continue;
        observed.add(candidate.prototype);
        for (const method of ['shutdown', 'close']) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate.prototype, method);
          if (typeof descriptor?.value !== 'function') continue;
          const original = descriptor.value, label = `${candidate.name}.${method}`;
          Object.defineProperty(candidate.prototype, method, { ...descriptor, value: function (...args) {
            const call = ++serial; record('method-start', { call, label });
            try {
              const result = original.apply(this, args);
              if (result && typeof result.then === 'function') result.then(() => record('method-done', { call, label }), error => record('method-error', { call, label, errorName: error?.name }));
              else record('method-done', { call, label });
              return result;
            } catch (error) { record('method-error', { call, label, errorName: error?.name }); throw error; }
          } });
          report.wrapped.push({ label, file: path.relative(actualApp, filename) });
        }
      }
    }
    // Main's final allSettled has a fixed service order in the actual bundle.
    // Observe individual settlement without replacing or cancelling promises.
    const allSettled = Promise.allSettled;
    Promise.allSettled = function (iterable) {
      const items = Array.from(iterable), group = ++serial;
      const stack = new Error().stack.split('\n').filter(line => line.includes('app.asar')).slice(0, 5);
      record('all-settled-start', { group, count: items.length, stack });
      items.forEach((item, index) => Promise.resolve(item).then(() => record('all-settled-item-done', { group, index }), error => record('all-settled-item-error', { group, index, errorName: error?.name })));
      const result = allSettled.call(this, items); result.then(() => record('all-settled-done', { group })); return result;
    };
    const listeners = app.rawListeners('before-quit');
    listeners.forEach((listener, index) => {
      app.removeListener('before-quit', listener);
      app.on('before-quit', function (...args) {
        record('before-quit-listener-start', { index, name: listener.listener?.name ?? listener.name });
        try { return listener.apply(this, args); }
        finally { record('before-quit-listener-returned', { index, defaultPrevented: args[0]?.defaultPrevented }); }
      });
    });
    app.once('will-quit', () => { report.willQuitObserved = true; record('will-quit'); });
    process.once('exit', code => record('process-exit', { code }));
    if (input.removeEffectsDisposer) {
      const crypto = nodeRequire('node:crypto'); report.removedEffectsDisposers = [];
      for (const window of BrowserWindow.getAllWindows()) for (const listener of window.rawListeners('closed')) {
        const source = Function.prototype.toString.call(listener.listener ?? listener);
        if (!source.includes('gpu-info-update')) continue;
        window.removeListener('closed', listener);
        report.removedEffectsDisposers.push({ windowId: window.id, sha256: crypto.createHash('sha256').update(source).digest('hex') });
      }
      record('removed-only-renderer-effects-disposer', { count: report.removedEffectsDisposers.length });
      if (!report.removedEffectsDisposers.length) throw new Error('No matching renderer effects disposer; preserving other listeners.');
    }
    if (input.primeWindow) {
      for (const window of BrowserWindow.getAllWindows()) { window.showInactive(); window.hide(); }
      record('primed-owned-native-windows');
    }
    report.offscreen = input.offscreen; report.primeWindow = input.primeWindow; report.removeEffectsDisposer = input.removeEffectsDisposer;
    globalThis.__worldlineboxShutdownDiagnostic = { input, report, record, app };
    record('armed', { beforeQuitListeners: listeners.length });
    return { pid, profile: actualProfile, appPath: actualApp, wrapped: report.wrapped, initialized: input.state };
  }, { profile: path.resolve(profile), executablePath, reportPath, state, offscreen, primeWindow, removeEffectsDisposer });
  mainPid = ownership.pid;
  const launcherPid = ownedProcess.pid, processes = await acceptanceProcesses();
  const ancestors = [], visited = new Set(); let currentPid = Number(ownership.pid);
  while (currentPid && !visited.has(currentPid)) {
    visited.add(currentPid); ancestors.push(currentPid);
    const item = processes.find(item => Number(item.ProcessId) === currentPid); currentPid = Number(item?.ParentProcessId);
  }
  const ownershipReport = JSON.parse(await readFile(reportPath, 'utf8'));
  Object.assign(ownershipReport, { launcherPid, mainPid: ownership.pid, mainAncestors: ancestors });
  await writeFile(reportPath, JSON.stringify(ownershipReport, null, 2));
  verified = ownership.pid === launcherPid || ancestors.includes(Number(launcherPid));
  if (!verified) throw new Error(`Main PID is not in the owned launcher process tree (${ownership.pid}/${launcherPid}).`);
  // Acquire the actual GUI Main's process handle before quit. The public
  // Playwright process is a cmd.exe parent on Windows, not this Main PID.
  const mainMonitor = monitorMainProcess(mainPid);
  await mainMonitor.ready;
  const mainOs = mainMonitor.result;
  const waiting = new Promise(resolve => ownedProcess.once('exit', (code, signal) => resolve({ code, signal })));
  await application.evaluate(({ app }, input) => {
    const diagnostic = globalThis.__worldlineboxShutdownDiagnostic;
    if (!diagnostic || diagnostic.report.pid !== process.pid || app.getPath('userData') !== diagnostic.report.profile
      || app.getAppPath() !== diagnostic.report.appPath) throw new Error('Diagnostic ownership changed before quit.');
    setTimeout(() => {
      if (app.getPath('userData') !== diagnostic.report.profile || app.getAppPath() !== diagnostic.report.appPath || process.pid !== diagnostic.report.pid) return;
      diagnostic.report.diagnosticForcedExit = true; diagnostic.record('diagnostic-deadline-exit'); app.exit(0);
    }, 20000).unref();
    Object.assign(diagnostic.report, input);
    if (input.deferredQuit) {
      const original = app.quit.bind(app); let requested = false;
      app.quit = function () {
        diagnostic.record('deferred-quit-requested');
        if (!requested) { requested = true; setTimeout(() => { diagnostic.record('original-quit-invoked'); original(); }, 100); }
      };
    }
    diagnostic.record('quit-ready');
  }, { deferredQuit, launcherPid, mainPid: ownership.pid, mainAncestors: ancestors });
  const closeStarted = Date.now();
  const closing = application.close().then(() => ({ closeResolved: true, elapsedMs: Date.now() - closeStarted }), error => ({ closeResolved: false, errorName: error?.name }));
  let deadlineTimer;
  const outcome = await Promise.race([Promise.all([waiting, closing, mainOs]).then(([process, close, mainOs]) => ({ process, close, mainOs })),
    new Promise(resolve => { deadlineTimer = setTimeout(() => resolve({ deadlineExceeded: true }), 25000); })]);
  clearTimeout(deadlineTimer);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const started = report.events.filter(event => event.type === 'method-start');
  const unresolvedMethods = started.filter(event => !report.events.some(item => ['method-done', 'method-error'].includes(item.type) && item.call === event.call)).map(event => event.label);
  const groups = report.events.filter(event => event.type === 'all-settled-start').map(group => ({ group: group.group, count: group.count, stack: group.stack,
    unresolvedIndices: Array.from({ length: group.count }, (_, index) => index).filter(index => !report.events.some(event => ['all-settled-item-done', 'all-settled-item-error'].includes(event.type) && event.group === group.group && event.index === index)) })).filter(group => group.unresolvedIndices.length);
  Object.assign(report, { processOutcome: outcome, unresolvedMethods, unresolvedGroups: groups, initialized: ownership.initialized,
    deferredQuit, launcherPid, mainPid: ownership.pid, mainAncestors: ancestors, stderrMarkers: [...stderrMarkers], asarBytes: asar.size, asarModifiedAt: asar.mtime.toISOString() });
  report.osGracefulShutdownVerified = outcome.close?.closeResolved === true && outcome.process?.code === 0 && outcome.mainOs?.observedExit === true && outcome.mainOs.mainExitCode === 0
    && !report.diagnosticForcedExit && unresolvedMethods.length === 0 && groups.length === 0;
  report.gracefulShutdownVerified = report.osGracefulShutdownVerified;
  report.acceptanceScope = finalFixed ? 'Isolated packaged shutdown with passive timing instrumentation; no listener removal, quit proxy, offscreen workaround, model requests or production-profile replay.'
    : 'Runtime diagnostic modifications only; not unmodified-package or production-profile acceptance.';
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: reportPath, forcedDiagnosticExit: report.diagnosticForcedExit, unresolvedMethods, unresolvedGroups: groups }));
} finally {
  if (application && ownedProcess?.exitCode === null && verified) {
    await application.evaluate(({ app }) => {
      const diagnostic = globalThis.__worldlineboxShutdownDiagnostic;
      if (diagnostic && diagnostic.report.pid === process.pid && app.getPath('userData') === diagnostic.report.profile && app.getAppPath() === diagnostic.report.appPath) {
        diagnostic.report.diagnosticForcedExit = true; diagnostic.record('diagnostic-finally-exit'); app.exit(0);
      }
    }).catch(() => undefined);
  }
  const stillAlive = (await acceptanceProcesses()).some(item => [mainPid, ownedProcess?.pid].includes(Number(item.ProcessId)));
  if (stillAlive) console.log(JSON.stringify({ retainedOwnedRoot: root, processExitNotYetProven: true }));
  else try { await removeAcceptanceRoot(root, process.pid); }
  catch { console.log(JSON.stringify({ retainedOwnedRoot: root, processExitNotYetProven: false })); }
}
