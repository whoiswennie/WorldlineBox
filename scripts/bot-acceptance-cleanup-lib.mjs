import { lstat, readdir, readFile, realpath, unlink, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const command = promisify(execFile);
const equal = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const prefix = /^worldlinebox-bot-(?:host|real)-[a-zA-Z0-9_-]+$/;
export async function acceptanceProcesses() {
  if (process.platform !== 'win32') return [];
  const { stdout } = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const value = JSON.parse(stdout || '[]'); return Array.isArray(value) ? value : [value];
}
export async function inspectAcceptanceRoot(root, processes, allowedOwnerPid) {
  const temporary = await realpath(os.tmpdir()), resolved = path.resolve(root), info = await lstat(resolved);
  if (!path.isAbsolute(root) || !equal(path.dirname(resolved), temporary) || !prefix.test(path.basename(resolved))
    || !info.isDirectory() || info.isSymbolicLink() || !equal(await realpath(resolved), resolved)) throw new Error('Acceptance cleanup target is not an ordinary owned temporary root.');
  const alive = new Set(processes.map(value => Number(value.ProcessId)));
  const active = processes.filter(value => Number(value.ProcessId) !== allowedOwnerPid && typeof value.CommandLine === 'string'
    && value.CommandLine.toLowerCase().replaceAll('/', '\\').includes(resolved.toLowerCase().replaceAll('/', '\\'))).map(value => Number(value.ProcessId));
  let owner, ownerPid;
  try { const marker = JSON.parse(await readFile(path.join(resolved, '.worldlinebox-acceptance.json'), 'utf8')); owner = marker.kind; ownerPid = marker.ownerPid; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (ownerPid && ownerPid !== allowedOwnerPid && alive.has(Number(ownerPid))) active.push(Number(ownerPid));
  if (path.basename(resolved).startsWith('worldlinebox-bot-host-')) {
    const records = JSON.parse(await readFile(path.join(resolved, 'native-instances.json'), 'utf8'));
    if (!Array.isArray(records) || !records.length || records.some(record => record.name !== 'Bot native acceptance' || record.runtimeId !== 'runtime-bot-acceptance' || !/^[a-z0-9-]{1,80}$/.test(record.id))) throw new Error('Native acceptance ownership metadata differs.');
    for (const record of records) try {
      const bridge = JSON.parse(await readFile(path.join(resolved, 'instances', record.id, 'bridge.json'), 'utf8'));
      if (alive.has(Number(bridge.pid))) active.push(Number(bridge.pid));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    owner = 'native-host-fixture';
  } else {
    const profile = await lstat(path.join(resolved, 'electron-profile'));
    if (!profile.isDirectory() || profile.isSymbolicLink()) throw new Error('Acceptance Electron profile is not an ordinary directory.');
    owner ??= 'legacy-real-or-protocol-fixture';
  }
  let files = 0, nestedLinks = 0;
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name), stat = await lstat(filename);
      if (stat.isSymbolicLink()) { nestedLinks++; continue; }
      if (stat.isDirectory()) { if (!equal(await realpath(filename), filename)) throw new Error('Unrecognized nested reparse directory.'); await walk(filename); }
      else files++;
    }
  };
  await walk(resolved);
  return { path: resolved, owner, rootReparse: false, nestedLinks, files, alivePids: [...new Set(active)] };
}
/** Links inside a fixture are unlinked themselves, never traversed. */
export async function removeAcceptanceRoot(root, allowedOwnerPid) {
  const temporary = await realpath(os.tmpdir()), resolved = path.resolve(root);
  if (!path.isAbsolute(root) || !equal(path.dirname(resolved), temporary) || !prefix.test(path.basename(resolved))) throw new Error('Acceptance cleanup target is outside its owned temporary namespace.');
  try { await lstat(resolved); } catch (error) { if (error.code === 'ENOENT') return { path: resolved, alreadyRemoved: true }; throw error; }
  const proof = await inspectAcceptanceRoot(root, await acceptanceProcesses(), allowedOwnerPid);
  if (proof.alivePids.length) throw new Error('Acceptance root still belongs to a live process: ' + proof.alivePids.join(','));
  const remove = async directory => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      let info; try { info = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (info.isSymbolicLink()) await unlink(filename);
      else if (info.isDirectory()) { if (!equal(await realpath(filename), filename)) throw new Error('Nested directory no longer resolves inside its owned fixture.'); await remove(filename); }
      else await unlink(filename);
    }
    try { await rmdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  for (let attempt = 0; ; attempt++) try {
    await remove(proof.path);
    try { await lstat(proof.path); } catch (error) { if (error.code === 'ENOENT') return proof; throw error; }
    throw Object.assign(new Error('Acceptance root remains after cleanup.'), { code: 'ENOTEMPTY' });
  }
  catch (error) {
    if (attempt >= 6 || !['EPERM','EACCES','EBUSY','ENOTEMPTY'].includes(error.code)) throw error;
    await delay(150 * (attempt + 1));
  }
}
