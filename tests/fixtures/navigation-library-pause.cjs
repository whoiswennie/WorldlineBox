/** Official storage controls, only for the owned navigation copy before Main opens it. */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron main fixture intentionally uses CommonJS. */
/* global require, process, console, setTimeout, clearTimeout */
const { app, utilityProcess } = require('electron');
const { randomUUID } = require('node:crypto');
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.env.WORLDLINEBOX_NAV_SNAPSHOT_ROOT ?? '');
const workerPath = process.env.WORLDLINEBOX_NAV_PACKAGED_WORKER;
if (!path.basename(root).startsWith('wlb-navigation-real-') || !workerPath?.includes('app.asar')) throw new Error('An owned snapshot and packaged Worker are required.');
const input = JSON.parse(readFileSync(path.join(root, 'private-ui-controls.json'), 'utf8'));
const relative = path.relative(root, input.databasePath);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The controlled database escaped its private snapshot.');
mkdirSync(path.join(root, 'pause-profile'), { recursive: true });
app.setPath('userData', path.join(root, 'pause-profile'));
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const child = utilityProcess.fork(workerPath, [], { serviceName: 'PrivateNavigationPause', stdio: 'pipe' });
  const pending = new Map();
  let readyResolve, readyReject, closeResolve, phase = 'starting';
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closed = new Promise(resolve => { closeResolve = resolve; });
  const log = path.join(root, 'private-pause-worker.log');
  child.stdout?.on('data', chunk => appendFileSync(log, chunk)); child.stderr?.on('data', chunk => appendFileSync(log, chunk));
  const timeout = setTimeout(() => { writeFileSync(path.join(root, 'ui-pause-result.json'), JSON.stringify({ completed: false, phase, timedOut: true })); child.kill(); app.exit(1); }, 60000);
  child.on('message', message => {
    if (message?.type) phase = message.type;
    if (message?.type === 'storage.failed') { appendFileSync(log, JSON.stringify(message)); readyReject(new Error('Private storage initialization failed.')); }
    if (message?.type === 'storage.booted') child.postMessage({ type: 'storage.initialize', databasePath: input.databasePath,
      hostRetention: { libraryPath: input.libraryPath, libraryId: input.libraryId } });
    if (message?.type === 'storage.ready') readyResolve();
    if (message?.type === 'storage.closed') closeResolve();
    const entry = pending.get(message?.requestId);
    if (entry) { pending.delete(message.requestId); if (message.response?.ok) entry.resolve(); else {
      appendFileSync(log, JSON.stringify({ phase, error: message.response?.error })); entry.reject(new Error('A private UI control was rejected.'));
    } }
  });
  try {
    await ready;
    for (const command of input.commands) {
      phase = command.type;
      await new Promise((resolve, reject) => { const requestId = randomUUID(); pending.set(requestId, { resolve, reject }); child.postMessage({ requestId, command }); });
    }
    child.postMessage({ type: 'storage.close' }); await closed;
    const counts = {};
    for (const command of input.commands) counts[command.type] = (counts[command.type] ?? 0) + 1;
    const result = { completed: true, pausedBaselineWorkCount: input.commands.length, controls: counts, onlyPrivateCopy: true };
    writeFileSync(path.join(root, 'ui-pause-result.json'), JSON.stringify(result)); console.log(JSON.stringify(result)); clearTimeout(timeout); app.exit(0);
  } catch (error) {
    appendFileSync(log, String(error?.stack ?? error)); writeFileSync(path.join(root, 'ui-pause-result.json'), JSON.stringify({ completed: false, phase, errorName: error?.name }));
    child.kill(); clearTimeout(timeout); app.exit(1);
  }
}).catch(() => app.exit(1));
