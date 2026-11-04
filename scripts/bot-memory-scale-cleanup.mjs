import { lstat, readdir, readFile, realpath, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acceptanceProcesses } from './bot-acceptance-cleanup-lib.mjs';

/** Only newly created scale fixtures. This can never target the two retained
 * .tools directories whose deletion was rejected by automatic policy. */
export async function removeMemoryScaleRoot(root, ownerPid, childPids = []) {
  const base = await realpath(os.tmpdir()), absolute = path.resolve(root), equal = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (!path.isAbsolute(root) || !equal(path.dirname(absolute), base) || !/^worldlinebox-bot-scale-[A-Za-z0-9_-]+$/.test(path.basename(absolute))) throw new Error('Scale cleanup target is outside its exact temporary-root contract');
  const stat = await lstat(absolute), marker = JSON.parse(await readFile(path.join(absolute, '.worldlinebox-memory-scale.json'), 'utf8'));
  if (!stat.isDirectory() || stat.isSymbolicLink() || !equal(await realpath(absolute), absolute) || marker.kind !== 'memory-scale-fixture' || marker.ownerPid !== ownerPid) throw new Error('Scale fixture ownership could not be proved');
  const processes = await acceptanceProcesses(), alive = new Set(processes.map(value => Number(value.ProcessId)));
  if (childPids.some(pid => alive.has(pid))) throw new Error('Scale fixture still has a live owned child; keep it for diagnosis');
  const active = processes.some(value => Number(value.ProcessId) !== ownerPid && typeof value.CommandLine === 'string'
    && value.CommandLine.toLowerCase().replaceAll('/', '\\').includes(absolute.toLowerCase().replaceAll('/', '\\')));
  if (active) throw new Error('Scale fixture still has an active process owner');
  const remove = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), info = await lstat(file);
      if (info.isSymbolicLink()) await unlink(file);
      else if (info.isDirectory()) { if (!equal(await realpath(file), file)) throw new Error('Scale fixture nested directory resolves elsewhere'); await remove(file); }
      else await unlink(file);
    }
    await rmdir(directory);
  };
  await remove(absolute);
  try { await lstat(absolute); throw new Error('Scale fixture remains after cleanup'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { removed: absolute, nestedLinksUnlinkedWithoutTraversal: true };
}
