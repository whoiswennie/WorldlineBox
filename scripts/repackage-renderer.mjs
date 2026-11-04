/** Renderer-only ASAR replacement. All staging and the retained backup stay
 * inside this workspace. No existing unpacked/native/extra-resource is written.
 * Usage (only after the official renderer build): node scripts/repackage-renderer.mjs --apply
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, realpathSync } from 'node:fs';
import { copyFile, constants, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as asar from '@electron/asar';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererPrefix = '.vite/renderer/main_window';
const rendererRoot = path.join(workspace, '.vite', 'renderer', 'main_window');
const target = path.join(workspace, 'out', 'WorldlineBox-win32-x64', 'resources', 'app.asar');
const unpacked = target + '.unpacked', executable = path.resolve(path.dirname(target), '..', 'WorldlineBox.exe');
const tools = path.join(workspace, '.tools'), lockPath = path.join(tools, 'repackage-renderer.lock');
const reports = path.join(workspace, 'artifacts', 'superagent-bot-development', 'renderer-repackage');
const command = promisify(execFile), token = randomUUID();
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isRenderer = name => name === rendererPrefix || name.startsWith(rendererPrefix + '/');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const nativeEntry = name => path.join(...name.split('/'));

function contained(filename) {
  if (!path.isAbsolute(filename)) throw new Error('Every repackage path must be absolute.');
  const relative = path.relative(workspace, filename);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Repackage path escapes the workspace.');
  return filename;
}
async function physical(filename) {
  contained(filename);
  const relative = path.relative(workspace, filename), parts = relative ? relative.split(path.sep) : [];
  let current = workspace;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !samePath(await realpath(current), current)) throw new Error('Physical symlinks/reparse paths are unsupported.');
  }
  return lstat(filename);
}
function checkedStream(filename, snapshot) {
  contained(filename);
  const current = lstatSync(filename);
  if (!current.isFile() || current.isSymbolicLink() || !samePath(realpathSync(filename), filename)
    || current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs || current.ino !== snapshot.ino) throw new Error('An input file changed during ASAR staging.');
  return createReadStream(filename);
}
async function hashFile(filename) {
  const before = await physical(filename);
  if (!before.isFile()) throw new Error('Expected an ordinary file.');
  const hash = createHash('sha256');
  for await (const bytes of checkedStream(filename, before)) hash.update(bytes);
  const after = await physical(filename);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('File changed while hashing.');
  return { size: before.size, sha256: hash.digest('hex'), mode: before.mode };
}
async function assertNoApplication() {
  const { stdout } = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(stdout || '[]'), processes = Array.isArray(parsed) ? parsed : [parsed];
  const alive = processes.filter(item => String(item.Name).toLowerCase() === 'worldlinebox.exe'
    || String(item.Name).toLowerCase() === 'electron.exe' && String(item.CommandLine).toLowerCase().includes(workspace.toLowerCase()));
  if (alive.length) throw new Error('Close WorldlineBox before repackaging. Active PIDs: ' + alive.map(item => item.ProcessId).join(','));
}
function archiveEntries(filename) {
  asar.uncache(filename);
  const output = [];
  function walk(node, prefix = '') {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      if (!name || name === '.' || name === '..' || /[\\/:\0]/u.test(name)) throw new Error('Unsupported ASAR entry name.');
      const relative = prefix ? prefix + '/' + name : name;
      if ('link' in entry) throw new Error('ASAR links are unsupported; the original package remains intact.');
      if (entry.files) { output.push({ path: relative, type: 'directory', unpacked: entry.unpacked === true }); walk(entry, relative); }
      else {
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid ASAR file size.');
        if (entry.executable) throw new Error('The official Windows streaming API cannot preserve existing executable header flags.');
        output.push({ path: relative, type: 'file', size: entry.size, unpacked: entry.unpacked === true,
          executable: entry.executable === true, integrity: entry.integrity });
      }
    }
  }
  walk(asar.getRawHeader(filename).header); return output;
}
async function physicalTree(directory, prefix = '') {
  if (!(await physical(directory)).isDirectory()) throw new Error('Expected an ordinary source directory.');
  const output = [];
  async function walk(current, relative) {
    for (const name of (await readdir(current)).sort()) {
      if (/[\\/:\0]/u.test(name)) throw new Error('Unsupported physical entry name.');
      const absolute = path.join(current, name), entry = await physical(absolute), filename = relative ? relative + '/' + name : name;
      if (entry.isDirectory()) { output.push({ path: filename, type: 'directory', mode: entry.mode }); await walk(absolute, filename); }
      else if (entry.isFile()) output.push({ path: filename, type: 'file', ...await hashFile(absolute) });
      else throw new Error('Unsupported non-file source entry.');
    }
  }
  await walk(directory, prefix); return output;
}
async function manifest(filename, entries) {
  const output = [];
  for (const entry of entries) {
    if (entry.type === 'directory') { output.push({ path: entry.path, type: entry.type, unpacked: entry.unpacked }); continue; }
    const bytes = asar.extractFile(filename, nativeEntry(entry.path), false), sha256 = digest(bytes);
    if (bytes.length !== entry.size || entry.integrity?.algorithm !== 'SHA256' || entry.integrity.hash !== sha256) throw new Error('ASAR content does not match its declared integrity: ' + entry.path);
    output.push({ path: entry.path, type: entry.type, size: entry.size, sha256, unpacked: entry.unpacked, executable: entry.executable });
  }
  return output.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function identical(expected, actual, label) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(label + ' differs; refusing replacement.');
}
async function syncFile(filename) { const handle = await open(filename, 'r+'); try { await handle.sync(); } finally { await handle.close(); } }

if (!process.argv.includes('--apply')) throw new Error('No package was changed. Use --apply after the official renderer build and review.');
if (process.platform !== 'win32') throw new Error('This strict repackage procedure currently supports the Windows package only.');
await physical(workspace); await physical(tools); await physical(rendererRoot); await physical(target); await physical(unpacked); await physical(executable);
await assertNoApplication();
const lock = await open(lockPath, 'wx', 0o600);
let stage, reportPath, report, replaced = false, committed = false;
try {
  stage = await mkdtemp(path.join(tools, 'renderer-repackage-')); await physical(stage);
  await lock.writeFile(JSON.stringify({ kind: 'renderer-repackage', token, pid: process.pid, stage })); await lock.sync();
  await mkdir(reports, { recursive: true }); await physical(reports);
  reportPath = path.join(reports, token + '.json');
  const stagedAsar = path.join(stage, 'app.asar'), backup = path.join(stage, 'original-app.asar');
  report = { kind: 'official-renderer-only-asar-repackage', token, startedAt: new Date().toISOString(), workspace, source: rendererRoot,
    target, stagedAsar, backup, stage, reportPath, replaced: false, committed: false, existingUnpackedWritten: false,
    executableWritten: false, extraResourcesWritten: false, api: '@electron/asar.createPackageFromStreams', phases: [] };
  const record = async phase => { report.phases.push({ phase, at: new Date().toISOString() }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ phase, reportPath })); };
  await writeFile(path.join(stage, '.renderer-repackage.json'), JSON.stringify({ kind: report.kind, token, ownerPid: process.pid }));
  await record('baseline');
  const oldEntries = archiveEntries(target);
  if (!oldEntries.some(entry => entry.path === rendererPrefix && entry.type === 'directory')) throw new Error('The baseline has no expected renderer root.');
  if (oldEntries.some(entry => isRenderer(entry.path) && entry.unpacked)) throw new Error('Replacing an unpacked renderer would require changing the existing unpacked tree.');
  report.baseline = { asar: await hashFile(target), executable: await hashFile(executable) };
  const oldManifest = await manifest(target, oldEntries), oldUnpacked = await physicalTree(unpacked), sourceManifest = await physicalTree(rendererRoot, rendererPrefix);
  const expectedUnpacked = oldEntries.filter(entry => entry.type === 'file' && entry.unpacked).map(entry => entry.path).sort();
  identical(expectedUnpacked, oldUnpacked.filter(entry => entry.type === 'file').map(entry => entry.path).sort(), 'Existing unpacked file set/header');
  if (!sourceManifest.some(entry => entry.path === rendererPrefix + '/index.html')) throw new Error('The renderer build has no index.html.');
  await writeFile(path.join(stage, 'baseline-manifest.json'), JSON.stringify(oldManifest, null, 2));
  await writeFile(path.join(stage, 'renderer-manifest.json'), JSON.stringify(sourceManifest, null, 2));
  const streams = [];
  for (const entry of oldEntries.filter(entry => !isRenderer(entry.path))) {
    if (entry.type === 'directory') streams.push({ path: entry.path, type: 'directory', unpacked: entry.unpacked });
    else if (entry.unpacked) {
      const absolute = path.join(unpacked, ...entry.path.split('/')), snapshot = await physical(absolute);
      streams.push({ path: entry.path, type: 'file', unpacked: true, stat: snapshot, streamGenerator: () => checkedStream(absolute, snapshot) });
    } else streams.push({ path: entry.path, type: 'file', unpacked: false, stat: { size: entry.size, mode: 0o100644 },
      streamGenerator: () => Readable.from(asar.extractFile(target, nativeEntry(entry.path), false)) });
  }
  streams.push({ path: rendererPrefix, type: 'directory', unpacked: false });
  for (const entry of sourceManifest) {
    if (entry.type === 'directory') streams.push({ path: entry.path, type: 'directory', unpacked: false });
    else {
      const absolute = path.join(rendererRoot, ...entry.path.slice(rendererPrefix.length + 1).split('/')), snapshot = await physical(absolute);
      streams.push({ path: entry.path, type: 'file', unpacked: false, stat: snapshot, streamGenerator: () => checkedStream(absolute, snapshot) });
    }
  }
  await record('official-stream-repackage');
  const output = await asar.createPackageFromStreams(stagedAsar, streams); await finished(output); await syncFile(stagedAsar);
  // Empty unpacked directories have no stream payload. Recreate them only in
  // staging so the staged tree can also be compared structurally.
  for (const entry of oldUnpacked.filter(entry => entry.type === 'directory')) await mkdir(path.join(stagedAsar + '.unpacked', ...entry.path.split('/')), { recursive: true });
  const newManifest = await manifest(stagedAsar, archiveEntries(stagedAsar));
  identical(oldManifest.filter(entry => !isRenderer(entry.path)), newManifest.filter(entry => !isRenderer(entry.path)), 'Every non-renderer ASAR entry');
  identical(oldUnpacked, await physicalTree(stagedAsar + '.unpacked'), 'Every staged unpacked byte/mode/path');
  identical(sourceManifest, await physicalTree(rendererRoot, rendererPrefix), 'Renderer build snapshot');
  const expectedRenderer = sourceManifest.filter(entry => entry.type === 'file').map(entry => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }));
  const actualRenderer = newManifest.filter(entry => isRenderer(entry.path) && entry.type === 'file').map(entry => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }));
  identical(expectedRenderer.sort((a,b) => a.path.localeCompare(b.path)), actualRenderer.sort((a,b) => a.path.localeCompare(b.path)), 'New renderer bytes');
  report.next = await hashFile(stagedAsar);
  report.verified = { nonRendererEntries: oldManifest.filter(entry => !isRenderer(entry.path)).length, unpackedFiles: expectedUnpacked.length,
    rendererFiles: expectedRenderer.length, packedIntegrityRecomputed: true, nonRendererUnchanged: true, stagedUnpackedIdentical: true };
  await writeFile(path.join(stage, 'new-manifest.json'), JSON.stringify(newManifest, null, 2));
  await record('verified-before-commit');
  await assertNoApplication();
  identical(report.baseline.asar, await hashFile(target), 'Baseline ASAR before commit');
  identical(oldUnpacked, await physicalTree(unpacked), 'Existing unpacked before commit');
  identical(report.baseline.executable, await hashFile(executable), 'Executable before commit');
  await copyFile(target, backup, constants.COPYFILE_EXCL); await syncFile(backup);
  identical(report.baseline.asar, await hashFile(backup), 'Retained baseline backup');
  await record('backup-verified');
  await assertNoApplication(); await physical(target); await physical(stagedAsar);
  identical(report.baseline.asar, await hashFile(target), 'Baseline immediately before replacement');
  await record('replacement-start');
  await rename(stagedAsar, target); replaced = true; report.replaced = true; asar.uncache(target);
  identical(report.next, await hashFile(target), 'Installed replacement ASAR');
  identical(newManifest, await manifest(target, archiveEntries(target)), 'Installed ASAR entries');
  identical(oldUnpacked, await physicalTree(unpacked), 'Unmodified existing unpacked after commit');
  identical(report.baseline.executable, await hashFile(executable), 'Unmodified executable after commit');
  const stdoutLog = path.join(reports, token + '.verify-package.stdout.log'), stderrLog = path.join(reports, token + '.verify-package.stderr.log');
  report.verifyPackage = { passed: false, stdoutLog, stderrLog };
  await record('verify-package-start');
  try {
    const verification = await command(process.execPath, [path.join(workspace, 'scripts', 'verify-package.mjs')], {
      cwd: workspace, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, WORLDLINEBOX_PACKAGE_ROOT: path.resolve(path.dirname(target), '..'), WORLDLINEBOX_PACKAGE_PLATFORM: 'win32-x64' },
    });
    await Promise.all([writeFile(stdoutLog, verification.stdout), writeFile(stderrLog, verification.stderr)]);
    report.verifyPackage.passed = true;
  } catch (verificationError) {
    await Promise.all([writeFile(stdoutLog, String(verificationError.stdout ?? '')), writeFile(stderrLog, String(verificationError.stderr ?? ''))]);
    report.verifyPackage.exitCode = verificationError.code;
    throw new Error('Full verify-package gate rejected the renderer replacement; restoring the retained ASAR backup.', { cause: verificationError });
  }
  committed = true; report.committed = true; report.completedAt = new Date().toISOString();
  await record('complete');
} catch (error) {
  if (report) {
    report.error = { name: error.name, message: error.message }; report.committed = committed;
    if (replaced && !committed) {
      try {
        await assertNoApplication();
        identical(report.next, await hashFile(target), 'Failed replacement identity before rollback');
        identical(report.baseline.asar, await hashFile(report.backup), 'Backup identity before rollback');
        const restore = path.join(stage, 'restore-app.asar');
        await copyFile(report.backup, restore, constants.COPYFILE_EXCL); await syncFile(restore);
        await rename(restore, target); asar.uncache(target);
        identical(report.baseline.asar, await hashFile(target), 'Restored baseline ASAR');
        report.rollback = { restored: true, backupPreserved: true };
      } catch (rollbackError) { report.rollback = { restored: false, backupPreserved: true, error: rollbackError.message }; }
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  throw error;
} finally {
  await lock.close();
  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  if (owner.token === token) await unlink(lockPath);
  // Keep staging, both manifests, the report and the original ASAR backup.
}
