import path from 'node:path';
import { lstat, readFile } from './disk';
import { readAsarEntry } from './runtime-service';
import { safeRelative } from './files';

/** Published Node packages and legacy desktop ASARs expose the same inspected SDK contract. */
export async function runtimeSdkRoot(program: string): Promise<string> {
  const receipt = await lstat(path.join(program, 'node-runtime.json')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (receipt) {
    if (!receipt.isFile() || receipt.isSymbolicLink()) throw new Error('Invalid Node runtime receipt.');
    return path.join(program, 'dsh', 'node_modules');
  }
  return path.join(program, 'resources', 'app.asar', 'dsh', 'node_modules');
}
export async function readRuntimeSdkFile(program: string, relative: string): Promise<Buffer> {
  const entry = safeRelative(relative);
  const root = await runtimeSdkRoot(program);
  if (root === path.join(program, 'resources', 'app.asar', 'dsh', 'node_modules')) return readAsarEntry(path.join(program, 'resources', 'app.asar'), `dsh/node_modules/${entry}`);
  const file = path.join(root, entry); const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Invalid runtime SDK resource.');
  return readFile(file);
}

export function runtimeProgramDirectory(executable: string): string {
  return path.basename(executable).toLowerCase() === 'node.exe' && path.basename(path.dirname(executable)).toLowerCase() === 'bin'
    ? path.dirname(path.dirname(executable)) : path.dirname(executable);
}
