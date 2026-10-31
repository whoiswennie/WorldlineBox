// A test-only host for the actual production UtilityProcess. No GUI or model.
import electron from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import {setTimeout,clearTimeout} from 'node:timers';
import {createHash,randomUUID} from 'node:crypto';
const {app,BrowserWindow,utilityProcess}=electron;
app.disableHardwareAcceleration();
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = path.resolve(config.root);
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('worldlinebox-recovery-ui-')) throw new Error('Unexpected isolated offline snapshot root.');
for (const file of [config.databasePath, config.destinationParent, config.reportPath, config.selection.libraryPath]) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Offline snapshot left its isolated fixture.');
}
if (path.resolve(config.workerPath)!==path.resolve(config.sourceAppPath,'.vite','build','companion_worker.js') || config.sourceIsPackaged&&!config.sourceAppPath.endsWith('app.asar')) throw new Error('Offline snapshot must use the actual captured application worker.');
const workerHash=createHash('sha256').update(fs.readFileSync(config.workerPath)).digest('hex');
if(workerHash!==config.expectedWorkerHash)throw new Error('Actual captured worker bytes changed before offline snapshot.');
app.setPath('userData', path.join(root, 'offline-snapshot-profile'));
app.whenReady().then(() => {
  const child = utilityProcess.fork(config.workerPath, [], { serviceName: 'Isolated Recovery Snapshot', stdio: 'pipe' });
  child.stdout?.resume(); child.stderr?.resume(); let settled = false;
  const end = (error, recovery) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); fs.writeFileSync(config.reportPath, JSON.stringify(error ? { error: String(error) } : { recovery, windows: BrowserWindow.getAllWindows().length,hostIsPackaged:app.isPackaged,workerPath:config.workerPath,workerHash,sourceWorkerFromPackagedASAR:config.sourceIsPackaged })); app.exit(error ? 1 : 0); };
  const timer = setTimeout(() => end(new Error('Offline fixture snapshot timed out.')), 60000);
  child.on('error', error => end(error)); child.on('exit', () => end(new Error('Offline fixture worker exited before its snapshot.')));
  child.on('message', value => {
    if (value.type === 'storage.booted') child.postMessage({ type: 'storage.initialize', databasePath: config.databasePath, hostRetention: config.selection });
    else if (value.type === 'storage.ready') child.postMessage({ requestId: randomUUID(), command: { type: 'recovery.backup.create', libraryId: config.selection.libraryId, operationId: randomUUID(), destinationParent: config.destinationParent } });
    else if (value.type === 'storage.failed') end(new Error(value.error));
    else if (value.response) { if (!value.response.ok || !value.response.recovery) end(new Error(value.response.error || 'Missing real snapshot result.')); else { config.recovery = value.response.recovery; child.postMessage({ type: 'storage.close' }); } }
    else if (value.type === 'storage.closed') end(undefined, config.recovery);
  });
});
