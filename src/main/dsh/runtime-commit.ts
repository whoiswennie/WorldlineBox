import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { copyFile, mkdir, rename, writeFile } from './disk';
import { copyTree, safeRelative } from './files';

// Scanner/indexer handles often omit FILE_SHARE_DELETE on recently extracted
// executables. Retry only the Windows sharing/access errors, for a bounded time.
export const WINDOWS_FILE_RETRY_DELAYS = [50, 100, 200, 400, 800, 1000, 1000] as const;
export function isFileBusyError(error: unknown): boolean {
  return ['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');
}

export async function retryFileOperation<T>(work: () => Promise<T>, options: {
  signal?: AbortSignal; delays?: readonly number[]; platform?: NodeJS.Platform;
} = {}): Promise<T> {
  const waits = options.delays ?? WINDOWS_FILE_RETRY_DELAYS;
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try { return await work(); }
    catch (error) {
      if ((options.platform ?? process.platform) !== 'win32' || !isFileBusyError(error) || attempt >= waits.length) throw error;
      await delay(waits[attempt], undefined, { signal: options.signal });
    }
  }
}

export async function atomicRuntimeJson(file: string, value: unknown, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', signal });
  await retryFileOperation(() => rename(temporary, file), { signal });
}

/**
 * A successful directory rename is atomic. If a Windows reader keeps the
 * original tree open, reserve a fresh destination and copy physical bytes.
 * The caller must verify the complete copy before the ready metadata is added;
 * neither a failed copy nor a cancellation can become a registered runtime.
 * Source and incomplete destination are deliberately retained on failure.
 */
export async function publishSealedArtifact(source: string, destination: string, options: {
  signal?: AbortSignal;
  verifyCopy: (directory: string) => Promise<void>;
  readyFiles?: readonly string[];
  onCopyFallback?: () => Promise<void>;
}): Promise<'renamed' | 'copied'> {
  try {
    await retryFileOperation(() => rename(source, destination), { signal: options.signal });
    return 'renamed';
  } catch (error) {
    options.signal?.throwIfAborted();
    // EXDEV is a legitimate copy case on any platform; other errors must keep
    // their original meaning. A permanent read/creation denial still fails.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV'
      && (process.platform !== 'win32' || !isFileBusyError(error))) throw error;
  }
  await options.onCopyFallback?.();
  options.signal?.throwIfAborted();
  const readyFiles = (options.readyFiles ?? ['seal.json', 'artifact.json']).map(safeRelative);
  // No recursive mkdir: never merge into an existing runtime, even after a race.
  await mkdir(destination);
  await copyTree(source, destination, { signal: options.signal, skip: relative => readyFiles.includes(relative) });
  await options.verifyCopy(destination);
  options.signal?.throwIfAborted();
  for (const relative of readyFiles) {
    const final = path.join(destination, relative);
    const temporary = `${final}.${randomUUID()}.tmp`;
    await retryFileOperation(() => copyFile(path.join(source, relative), temporary), { signal: options.signal });
    await retryFileOperation(() => rename(temporary, final), { signal: options.signal });
  }
  return 'copied';
}
