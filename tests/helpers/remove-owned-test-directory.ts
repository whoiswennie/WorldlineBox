import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** Synchronous fixture counterpart for Playwright's existing cleanup callbacks. */
export function removeOwnedDirectorySync(root: string): void {
  if (!path.isAbsolute(root) || path.parse(root).root === path.resolve(root)) throw new Error('Unsafe test directory removal.');
  const remove = (directory: string): void => {
    let entry;
    try { entry = lstatSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Removal root must be a real owned directory.');
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
