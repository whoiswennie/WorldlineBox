import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Electron's virtual ASAR filesystem must not expand archives while sealing or copying a runtime.
const load = createRequire(path.join(process.cwd(), 'worldlinebox-dsh-disk.cjs'));
const physicalFs: typeof nodeFs = process.versions.electron ? load('original-fs') : nodeFs;
export const createReadStream: typeof nodeFs.createReadStream = (file, options) => physicalFs.createReadStream(file, {
  ...(typeof options === 'string' ? { encoding: options } : options), fs: physicalFs,
});
export const createWriteStream: typeof nodeFs.createWriteStream = (file, options) => physicalFs.createWriteStream(file, {
  ...(typeof options === 'string' ? { encoding: options } : options), fs: physicalFs,
});
export const { appendFile, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } = physicalFs.promises;

export async function* readChunks(file: nodeFs.PathLike, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const handle = await physicalFs.promises.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
}
