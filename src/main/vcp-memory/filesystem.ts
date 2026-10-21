import { lstat, readdir, readlink, realpath, rmdir, unlink } from 'node:fs/promises';
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** A killed worker cannot run its own close; detach its two dependency links
 * after process exit without opening or enumerating either external target.
 */
export async function detachRuntimeDependencyLinks(scopeRoot: string): Promise<void> {
  if (!path.isAbsolute(scopeRoot) || path.parse(scopeRoot).root === path.resolve(scopeRoot)) throw new Error('Unsafe VCP runtime scope.');
  const runtimeRoot = path.join(scopeRoot, 'runtime');
  for (const directory of [scopeRoot, runtimeRoot]) {
    let info;
    try { info = await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('VCP runtime ancestor must remain a real directory.');
  }
  const physicalScope = await realpath(scopeRoot), physicalRuntime = await realpath(runtimeRoot);
  if (path.dirname(physicalRuntime) !== physicalScope) throw new Error('VCP runtime parent changed.');
  for (const name of ['node_modules', 'rust-vexus-lite']) {
    const target = path.join(runtimeRoot, name);
    let info;
    try { info = await lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!info.isSymbolicLink() || !path.isAbsolute(await readlink(target))) throw new Error('Unexpected VCP runtime dependency entry.');
    // This path is the link itself. Never resolve, enumerate or remove its source.
    await unlink(target);
  }
}

/** Delete only entries owned by this directory, never traversing directory links.
 * In particular, a Windows junction must be unlinked before visiting its parent.
 * Callers must first establish that root is their own cache or temporary directory.
 */
export async function removeOwnedDirectory(root: string): Promise<void> {
  if (!path.isAbsolute(root) || path.parse(root).root === path.resolve(root)) throw new Error('Unsafe VCP directory removal.');
  let entry;
  try { entry = await lstat(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('VCP removal root must be a real owned directory.');
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    const child = await lstat(file);
    if (child.isSymbolicLink()) await unlink(file);
    else if (child.isDirectory()) await removeOwnedDirectory(file);
    else await unlink(file);
  }
  // Deliberately omit recursive removal: even an unexpected remaining junction
  // cannot cause the operating system's recursive remover to visit its target.
  await rmdir(root);
}

/** Synchronous fixture counterpart for Playwright's existing cleanup callbacks. */
export function removeOwnedDirectorySync(root: string): void {
  if (!path.isAbsolute(root) || path.parse(root).root === path.resolve(root)) throw new Error('Unsafe VCP directory removal.');
  const remove = (directory: string): void => {
    let entry;
    try { entry = lstatSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('VCP removal root must be a real owned directory.');
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      let child;
      try { child = lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (child.isSymbolicLink()) unlinkSync(file);
      else if (child.isDirectory()) remove(file);
      else unlinkSync(file);
    }
    rmdirSync(directory);
  };
  for (let attempt = 0; ; attempt++) {
    try { remove(root); return; }
    catch (error) {
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
