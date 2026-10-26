import { open, rename } from 'node:fs/promises';
import path from 'node:path';

/** File sync is mandatory. Windows commonly cannot fsync directory handles;
 * expose that limited filesystem boundary instead of claiming power-loss safety. */
export async function syncPreparedDirectory(directory: string): Promise<boolean> {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); return true; }
  catch (error) {
    if (process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  } finally { await handle?.close(); }
}
export async function writeDurablePreparedFile(temporary: string, target: string, contents: string): Promise<void> {
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target); await syncPreparedDirectory(path.dirname(target));
}
