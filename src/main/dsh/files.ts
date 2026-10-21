import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { readChunks, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from './disk';
import path from 'node:path';

export function contained(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes managed directory.');
  return target;
}

export function safeRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.length > 2000 || normalized.includes('\0') || normalized.startsWith('/')) throw new Error('Invalid archive path.');
  const parts = normalized.replace(/\/$/, '').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[:<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) throw new Error('Unsafe archive path.');
  return parts.join('/');
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
  await rename(temporary, file);
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function hashFile(file: string, signal?: AbortSignal, size?: number): Promise<string> {
  const digest = createHash('sha256');
  signal?.throwIfAborted();
  if (size !== undefined && size < 1024 * 1024) digest.update(await readFile(file, { signal }));
  else for await (const chunk of readChunks(file, signal)) digest.update(chunk);
  return digest.digest('hex');
}

export interface TreeFile { path: string; sha256: string; size: number }
export interface TreeInventory { files: TreeFile[]; contentSha256: string; fileCount: number; byteLength: number }
export interface TreeHashCacheEntry { fingerprint: string; sha256: string }
export interface TreeInventoryProgress { phase: 'scanning' | 'hashing' | 'complete'; scannedEntries: number; fileCount: number; verifiedFiles: number; cacheHits: number; verifiedBytes: number }
export async function inventoryTree(root: string, signal?: AbortSignal, progress?: (count: number, file: string) => Promise<void>, cache?: Map<string, TreeHashCacheEntry>, observe?: (progress: TreeInventoryProgress) => void): Promise<TreeInventory> {
  let active = 0; let count = 0;
  let verifiedFiles = 0, cacheHits = 0, verifiedBytes = 0;
  const report = (phase: TreeInventoryProgress['phase'], fileCount = 0) => observe?.({ phase, scannedEntries: count, fileCount, verifiedFiles, cacheHits, verifiedBytes });
  report('scanning');
  const queue: Array<() => void> = [];
  const fingerprints = new Map<string, string>();
  const fingerprint = (stat: Stats) => JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.dev]);
  const limit = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= 32) await new Promise<void>(resolve => queue.push(resolve));
    else active++;
    try { signal?.throwIfAborted(); return await work(); }
    finally { const waiting = queue.shift(); if (waiting) waiting(); else active--; }
  };
  const walk = async (directory: string, prefix: string): Promise<TreeFile[]> => {
    const entries = (await limit(() => readdir(directory, { withFileTypes: true }))).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const groups = await Promise.allSettled(entries.map(async entry => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelative(relative);
      if (++count > 150_000) throw new Error('Too many entries in managed tree.');
      if (count % 500 === 0) report('scanning');
      const stat = await limit(() => lstat(path.join(directory, entry.name)));
      if (stat.isSymbolicLink()) throw new Error(`Linked file is not allowed in a sealed tree: ${relative}`);
      if (stat.isDirectory()) return walk(path.join(directory, entry.name), relative);
      if (!stat.isFile()) throw new Error(`Unsupported file: ${relative}`);
      if (cache) fingerprints.set(relative, fingerprint(stat));
      return [{ path: relative, sha256: '', size: stat.size }];
    }));
    const failure = groups.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return groups.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  };
  const files = await walk(root, '');
  report('hashing', files.length);
  let next = 0;
  // Bounded parallel I/O avoids serial event-loop turns for thousands of tiny dependency files.
  const hashed = await Promise.allSettled(Array.from({ length: Math.min(32, files.length) }, async () => {
    while (next < files.length) {
      signal?.throwIfAborted();
      const index = next++; const file = files[index]!;
      await progress?.(index, file.path);
      const stamp = fingerprints.get(file.path); const previous = cache?.get(file.path);
      if (previous && previous.fingerprint === stamp) { file.sha256 = previous.sha256; cacheHits++; }
      else {
        file.sha256 = await hashFile(contained(root, file.path), signal, file.size);
        if (cache) {
          const after = await lstat(contained(root, file.path));
          if (!after.isFile() || after.isSymbolicLink() || fingerprint(after) !== stamp) throw new Error('File changed during integrity verification.');
          cache.set(file.path, { fingerprint: stamp!, sha256: file.sha256 });
        }
      }
      verifiedFiles++; verifiedBytes += file.size;
      if (verifiedFiles % 250 === 0) report('hashing', files.length);
    }
  }));
  const failure = hashed.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const contentSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  report('complete', files.length);
  return { files, contentSha256, fileCount: files.length, byteLength: files.reduce((sum, file) => sum + file.size, 0) };
}

/** Flatten only links whose targets stay inside explicitly owned roots. Never copy external links. */
export async function copyTree(source: string, destination: string, options: {
  signal?: AbortSignal; skip?: (relative: string) => boolean; allowedLinkRoots?: string[]; concurrency?: number;
} = {}): Promise<void> {
  const concurrency = Math.max(1, Math.min(32, Math.floor(options.concurrency ?? 1)));
  if (!Number.isFinite(concurrency)) throw new Error('Invalid copy concurrency.');
  let active = 0; const queue: Array<() => void> = [];
  const limit = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>(resolve => queue.push(resolve)); else active++;
    try { options.signal?.throwIfAborted(); return await work(); }
    finally { const waiting = queue.shift(); if (waiting) waiting(); else active--; }
  };
  const roots = await Promise.all([source, ...(options.allowedLinkRoots ?? [])].map(p => realpath(p)));
  let count = 0;
  const walk = async (from: string, to: string, relative: string, ancestors: Set<string>) => {
    options.signal?.throwIfAborted();
    if (options.skip?.(relative)) return;
    const actual = await limit(() => realpath(from));
    if (!roots.some(root => { const rel = path.relative(root, actual); return !rel.startsWith('..') && !path.isAbsolute(rel); })) throw new Error(`Link points outside managed data: ${relative}`);
    const stat = await limit(() => lstat(actual));
    if (stat.isDirectory()) {
      if (ancestors.has(actual.toLowerCase())) throw new Error(`Recursive directory link: ${relative}`);
      const next = new Set(ancestors).add(actual.toLowerCase());
      await limit(() => mkdir(to, { recursive: true }));
      const visit = async (entry: string) => {
        const child = relative ? `${relative}/${entry}` : entry;
        safeRelative(child);
        await walk(path.join(actual, entry), path.join(to, entry), child, next);
      };
      const entries = await limit(() => readdir(actual));
      if (concurrency === 1) { for (const entry of entries) await visit(entry); }
      else {
        const results = await Promise.allSettled(entries.map(visit));
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      }
    } else if (stat.isFile()) {
      if (++count > 150_000) throw new Error('Too many files to copy.');
      // A visited parent directory already exists; only a file used as the root needs mkdir.
      if (!relative) await limit(() => mkdir(path.dirname(to), { recursive: true }));
      await limit(() => copyFile(actual, to));
    } else throw new Error(`Unsupported data file: ${relative}`);
  };
  await walk(source, destination, '', new Set());
}

export async function removeManaged(root: string, target: string): Promise<void> {
  const managedRoot = await realpath(root);
  const actual = await realpath(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (actual === undefined) return;
  const rel = path.relative(managedRoot, actual);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Refusing to remove outside managed storage.');
  await rm(actual, { recursive: true, force: true });
}

/** Verify every resolved ancestor before a directory is moved or used for scratch data. */
export async function assertOwnedDirectory(root: string, directory: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Directory is outside managed storage.');
  const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed directory cannot be a link.');
  const expected = path.join(await realpath(root), relative); const actual = await realpath(directory);
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (key(expected) !== key(actual)) throw new Error('Managed directory resolves through an unexpected link.');
}

export function redact(text: string): string {
  return text.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+[^?\s"']*\?)[^\s"']+/gi, '$1[redacted]')
    .replace(/([?&](?:token|key|api_key|auth|access_token)=)[^\s&#"']+/gi, '$1[redacted]')
    .replace(/\b(sk-[a-z0-9_-]{8,})\b/gi, '[redacted]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,"'}]+/gi, '$1[redacted]');
}
