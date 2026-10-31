/** Relocate only an owned real-library copy through the packaged Worker protocol. */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron main fixture intentionally uses CommonJS. */
/* global require, process, console, setTimeout, clearTimeout */
const { app, utilityProcess } = require('electron');
const { randomUUID } = require('node:crypto');
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.env.WORLDLINEBOX_NAV_SNAPSHOT_ROOT ?? '');
const workerPath = process.env.WORLDLINEBOX_NAV_PACKAGED_WORKER;
if (!path.basename(root).startsWith('wlb-navigation-real-') || !workerPath?.includes('app.asar')) {
  throw new Error('Relink requires the owned snapshot and an explicit packaged Worker.');
}
const manifest = JSON.parse(readFileSync(path.join(root, 'private-manifest.json'), 'utf8'));
function owned(candidate) {
  const relative = path.relative(root, path.resolve(candidate));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
if (!owned(manifest.copiedLibrary) || path.resolve(manifest.copiedLibrary) === path.resolve(manifest.sourceLibrary)
  || manifest.linkedRoots.some(entry => !owned(entry.copiedRoot))) throw new Error('Relink target escaped its private snapshot.');
const userData = path.join(root, 'relink-profile');
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.disableHardwareAcceleration();

void app.whenReady().then(async () => {
  let child;
  const pending = new Map();
  const report = { packagedWorker: true, relinkedRoots: 0, existingRelocatedRoots: 0, forcedCleanup: false };
  try {
    child = utilityProcess.fork(workerPath, [], { serviceName: 'PrivateNavigationRelink', stdio: 'pipe' });
    const log = path.join(root, 'private-relink-worker.log');
    child.stdout?.on('data', chunk => appendFileSync(log, chunk));
    child.stderr?.on('data', chunk => appendFileSync(log, chunk));
    let readyResolve, shutdownResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const stopped = new Promise(resolve => { shutdownResolve = resolve; });
    child.on('message', message => {
      if (message?.type === 'worker.ready') readyResolve();
      if (message?.type === 'worker.shutdown.ack') shutdownResolve();
      if (!message?.requestId) return;
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      clearTimeout(waiter.timer);
      if (message.result?.ok) waiter.resolve(message.result);
      else waiter.reject(Object.assign(new Error('Private relink Worker command failed.'), { code: message.result?.error?.code }));
    });
    async function bounded(promise, label, timeoutMs = 120000) {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs); })]); }
      finally { clearTimeout(timer); }
    }
    function request(command) {
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Private relink request timed out.')); }, 120000);
        pending.set(requestId, { resolve, reject, timer });
        child.postMessage({ requestId, command });
      });
    }
    await bounded(ready, 'Packaged Worker did not become ready.');
    const opened = await request({ type: 'library.open', selectedLibraryPath: manifest.copiedLibrary });
    const libraryId = opened.library.libraryId;
    const linked = await request({ type: 'linked-folder.list', libraryId });
    for (const entry of manifest.linkedRoots) {
      const current = linked.folders.find(folder => folder.folderId === entry.folderId);
      if (current && path.resolve(current.absoluteRootPath).toLowerCase() === path.resolve(entry.copiedRoot).toLowerCase()) {
        report.existingRelocatedRoots++; continue;
      }
      await request({ type: 'linked-folder.relink', libraryId, folderId: entry.folderId, newRootPath: entry.copiedRoot });
      report.relinkedRoots++;
    }
    // On the first open the copied catalog still named the original root.
    // Reopen after relocation so production's root-aware technical rules run.
    await request({ type: 'library.close', libraryId });
    await request({ type: 'library.open', selectedLibraryPath: manifest.copiedLibrary });
    const normal = await request({ type: 'asset.list', libraryId, recursive: true, showIgnored: false });
    const all = await request({ type: 'asset.list', libraryId, recursive: true, showIgnored: true });
    const baselineIds = new Set(manifest.assets.map(asset => asset.asset_id));
    if (all.assets.some(asset => !baselineIds.has(asset.assetId))) throw new Error('Relink unexpectedly created asset identities.');
    report.normalBrowseCount = normal.assets.length;
    report.normalBrowseAvailable = normal.assets.filter(asset => asset.availability === 'available').length;
    report.showIgnoredCount = all.assets.length;
    report.hiddenByIgnoreCount = all.assets.length - normal.assets.length;
    writeFileSync(path.join(root, 'private-browse-ids.json'), JSON.stringify({ visibleIds: normal.assets.map(asset => asset.assetId) }));
    await request({ type: 'library.close', libraryId });
    child.postMessage({ type: 'worker.shutdown' });
    await bounded(stopped, 'Packaged Worker did not shut down.', 15000);
    writeFileSync(path.join(root, 'relink-result.json'), JSON.stringify({ ...report, completed: true }));
    console.log(JSON.stringify({ ...report, completed: true }));
    app.exit(0);
  } catch (error) {
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    child?.kill();
    report.forcedCleanup = !!child;
    writeFileSync(path.join(root, 'private-relink-error.txt'), String(error?.stack ?? error));
    writeFileSync(path.join(root, 'relink-result.json'), JSON.stringify({ ...report, completed: false, errorName: error?.name, errorCode: error?.code }));
    console.error(JSON.stringify({ completed: false, errorName: error?.name, errorCode: error?.code }));
    app.exit(1);
  }
}).catch(() => app.exit(1));
