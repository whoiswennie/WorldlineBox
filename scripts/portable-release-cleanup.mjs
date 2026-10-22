import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const releaseId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Remove only this build's completed export, after its package verification. */
export async function cleanupPortableRelease(projectRoot, resourcesRoot) {
  const project = path.resolve(projectRoot);
  const releaseParent = path.join(project, '.tools', 'portable-release');
  const resources = path.resolve(resourcesRoot);
  const stage = path.dirname(resources);
  if (!releaseId.test(path.basename(stage)) || path.dirname(stage) !== releaseParent
    || resources !== path.join(stage, 'resources')) {
    throw new Error('Portable release cleanup requires this project\'s UUID/resources path.');
  }

  // Check every owned ancestor before recursive removal; a junction must never
  // turn a disposable export into an alias for real project or external data.
  for (const directory of [project, path.join(project, '.tools'), releaseParent, stage, resources]) {
    let info;
    try { info = await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()
      || path.relative(directory, await realpath(directory)) !== '') {
      throw new Error(`Unsafe portable release cleanup directory: ${directory}`);
    }
  }

  // fs.rm removes nested symbolic links/junctions themselves without following
  // their targets. Never sweep siblings: another UUID may be an active build.
  await rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/portable-release-cleanup.mjs <UUID/resources>');
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (await cleanupPortableRelease(projectRoot, process.argv[2])) console.log('Removed this build\'s verified portable release export.');
}
