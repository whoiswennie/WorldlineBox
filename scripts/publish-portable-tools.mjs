import { lstat, mkdir, mkdtemp, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function ordinaryDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Portable tool publication requires ordinary directories.');
  return realpath(directory);
}

async function move(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (attempt === 8 || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
      await setTimeout(200 * (attempt + 1));
    }
  }
}

/** Publish an already verified bundle; preserve the old payload and roll back a failed swap. */
export async function publishPortableTools(projectRoot, staging, replaceExisting = false) {
  const project = await realpath(projectRoot);
  const stagingParent = await ordinaryDirectory(path.join(project, '.tools/portable-tool-staging'));
  if (stagingParent !== path.join(project, '.tools/portable-tool-staging')) throw new Error('Portable tool staging escaped the project.');
  const staged = await realpath(staging);
  if (path.dirname(staged) !== stagingParent || !path.basename(staged).startsWith('bundle-')) throw new Error('Invalid portable tool staging path.');
  const targetParent = await ordinaryDirectory(path.join(project, 'resources/portable-tools'));
  if (targetParent !== path.join(project, 'resources/portable-tools')) throw new Error('Portable tool target escaped the project.');
  const target = path.join(targetParent, 'win32-x64');
  const lockPath = path.join(stagingParent, 'publish.lock');
  const lease = await open(lockPath, 'wx');
  let backup;
  try {
    const existing = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing) {
      if (!replaceExisting) throw new Error('Portable payload already exists. Run acquisition with --repair to replace it safely.');
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Refusing to replace a linked or invalid portable payload.');
      const backupParent = await ordinaryDirectory(path.join(project, '.tools/portable-tool-backups'));
      if (backupParent !== path.join(project, '.tools/portable-tool-backups')) throw new Error('Portable tool backup escaped the project.');
      backup = path.join(await mkdtemp(path.join(backupParent, 'bundle-')), 'win32-x64');
      await move(target, backup);
    }
    try { await move(staged, target); }
    catch (error) {
      if (backup) {
        try { await move(backup, target); }
        catch (rollback) { throw new AggregateError([error, rollback], `Portable publication failed. Previous tools remain at ${backup}. Close the application and retry.`, { cause: rollback }); }
      }
      throw error;
    }
    return { target, backup };
  } finally {
    await lease.close();
    await unlink(lockPath);
  }
}
