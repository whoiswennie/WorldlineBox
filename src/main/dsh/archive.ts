import { createHash, randomUUID } from 'node:crypto';
import { readChunks, createWriteStream, lstat, mkdir, readdir, rename, rm, stat } from './disk';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { openPromise } from 'yauzl';
import { z } from 'zod';
import { contained, inventoryTree, safeRelative, type TreeInventory } from './files';

export const ARCHIVE_LIMITS = Object.freeze({ files: 150_000, fileBytes: 1024 ** 3, totalBytes: 8 * 1024 ** 3, manifestBytes: 32 * 1024 ** 2 });
const fileSchema = z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative().max(ARCHIVE_LIMITS.fileBytes) });
const sealSchema = z.object({
  files: z.array(fileSchema).max(ARCHIVE_LIMITS.files), contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  fileCount: z.number().int().nonnegative().max(ARCHIVE_LIMITS.files), byteLength: z.number().int().nonnegative().max(ARCHIVE_LIMITS.totalBytes),
}).passthrough();
export type SealedArchiveManifest = z.infer<typeof sealSchema>;
const caseKey = (value: string): string => value.normalize('NFC').toUpperCase();

function registerPath(value: string, entries: Map<string, 'file' | 'directory'>, kind: 'file' | 'directory'): void {
  const parts = safeRelative(value).split('/');
  let prefix = '';
  for (let index = 0; index < parts.length; index++) {
    prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]!;
    const key = caseKey(prefix);
    const desired = index === parts.length - 1 ? kind : 'directory';
    const previous = entries.get(key);
    if (previous === 'file' || (previous !== undefined && desired === 'file')) throw new Error(`Duplicate or colliding archive path: ${value}`);
    entries.set(key, desired);
  }
}

export function parseSealedManifest(value: unknown): SealedArchiveManifest {
  const result = sealSchema.parse(value);
  const names = new Map<string, 'file' | 'directory'>();
  const exactNames = new Map<string, string>();
  for (const file of result.files) {
    if (safeRelative(file.path) !== file.path) throw new Error('Noncanonical manifest file path.');
    registerPath(file.path, names, 'file');
    for (const prefix of file.path.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))) {
      const key = caseKey(prefix);
      const previous = exactNames.get(key);
      if (previous !== undefined && previous !== prefix) throw new Error('Case-colliding archive paths.');
      exactNames.set(key, prefix);
    }
  }
  if (result.fileCount !== result.files.length || result.byteLength !== result.files.reduce((sum, file) => sum + file.size, 0)) throw new Error('Archive inventory totals do not match.');
  if (createHash('sha256').update(JSON.stringify(result.files)).digest('hex') !== result.contentSha256) throw new Error('Archive inventory seal does not match.');
  return result;
}

export async function validateSealedDirectory(directory: string, manifest: unknown, signal?: AbortSignal): Promise<SealedArchiveManifest> {
  const parsed = parseSealedManifest(manifest);
  const actual = await inventoryTree(directory, signal);
  const byPath = new Map(actual.files.map(file => [file.path, file]));
  if (actual.fileCount !== parsed.fileCount || actual.byteLength !== parsed.byteLength || parsed.files.some(file => {
    const observed = byPath.get(file.path);
    return observed === undefined || observed.sha256 !== file.sha256 || observed.size !== file.size;
  })) throw new Error('Stored archive data failed integrity verification.');
  return parsed;
}

/** The inventory is controlled by the writer, never by caller-supplied metadata. */
export async function writeSealedArchive(directory: string, filePath: string, manifest: Record<string, unknown>, signal?: AbortSignal): Promise<SealedArchiveManifest> {
  const inventory = await inventoryTree(directory, signal);
  const sealed = parseSealedManifest({ ...manifest, ...inventory });
  const serialized = JSON.stringify(sealed, null, 2);
  if (Buffer.byteLength(serialized) > ARCHIVE_LIMITS.manifestBytes) throw new Error('Archive manifest exceeds the limit.');
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.partial`;
  const output = createWriteStream(temporary, { flags: 'wx' });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  let currentSource: Readable | undefined;
  archive.on('warning', (error: Error) => archive.destroy(error));
  const transfer = pipeline(archive, output, { signal });
  // Attach the rejection handler immediately while the archive is being populated.
  void transfer.catch(() => undefined);
  try {
    archive.append(serialized, { name: 'manifest.json' });
    for (const file of sealed.files) {
      signal?.throwIfAborted();
      const source = contained(directory, file.path);
      const stream = Readable.from(readChunks(source, signal));
      currentSource = stream;
      // Archiver pipes appended streams immediately, so enqueueing thousands opens thousands of files.
      // Only append the next source after this source has been consumed and its handle closed.
      stream.on('error', error => { if (!archive.destroyed) archive.destroy(error); });
      const consumed = finished(stream, { cleanup: true });
      void consumed.catch(() => undefined);
      archive.append(stream, { name: `data/${file.path}` });
      await Promise.race([consumed, transfer]);
      currentSource = undefined;
    }
    await archive.finalize();
    await transfer;
    signal?.throwIfAborted();
    // Recheck sources in case an external process modified an exported instance.
    await validateSealedDirectory(directory, sealed, signal);
    await rename(temporary, filePath);
    return sealed;
  } catch (error) {
    if (currentSource) {
      currentSource.destroy();
      await finished(currentSource, { cleanup: true }).catch(() => undefined);
    }
    archive.abort(); output.destroy();
    await transfer.catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Extract only regular inventory files into an empty staging directory, and verify every byte. */
export async function extractSealedArchive(filePath: string, destination: string, signal?: AbortSignal): Promise<SealedArchiveManifest> {
  if ((await stat(filePath)).size > ARCHIVE_LIMITS.totalBytes + ARCHIVE_LIMITS.manifestBytes) throw new Error('Archive exceeds the size limit.');
  await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new Error('Archive destination cannot be linked.');
  if ((await readdir(destination)).length > 0) throw new Error('Archive destination must be empty.');
  const zip = await openPromise(filePath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  if (zip.entryCount > ARCHIVE_LIMITS.files * 2 + 1) { zip.close(); throw new Error('Archive has too many entries.'); }
  const actualFiles: TreeInventory['files'] = [];
  const entries = new Map<string, 'file' | 'directory'>();
  const seenEntries = new Set<string>();
  const exactNames = new Map<string, string>();
  let manifest: SealedArchiveManifest | undefined;
  let total = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      const directory = entry.fileName.endsWith('/');
      const name = safeRelative(entry.fileName);
      if (seenEntries.has(caseKey(name))) throw new Error('Duplicate ZIP entry.');
      seenEntries.add(caseKey(name));
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (entry.isEncrypted() || !entry.canDecodeFileData() || (mode !== 0 && mode !== 0o100000 && mode !== 0o040000)) throw new Error('Linked, encrypted or unsupported ZIP entry.');
      registerPath(name, entries, directory ? 'directory' : 'file');
      for (const prefix of name.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))) {
        const key = caseKey(prefix);
        const previous = exactNames.get(key);
        if (previous !== undefined && previous !== prefix) throw new Error('Case-colliding ZIP entry.');
        exactNames.set(key, prefix);
      }
      if (directory) {
        if (name !== 'data' && !name.startsWith('data/')) throw new Error('Unexpected archive directory.');
        continue;
      }
      if (name === 'manifest.json') {
        if (entry.uncompressedSize > ARCHIVE_LIMITS.manifestBytes) throw new Error('Archive manifest exceeds the limit.');
        const stream = await zip.openReadStreamPromise(entry);
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          length += chunk.length;
          if (length > ARCHIVE_LIMITS.manifestBytes) { stream.destroy(); throw new Error('Archive manifest exceeds the limit.'); }
          chunks.push(Buffer.from(chunk));
        }
        manifest = parseSealedManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        continue;
      }
      if (!name.startsWith('data/') || entry.uncompressedSize > ARCHIVE_LIMITS.fileBytes) throw new Error('Unexpected or oversized archive entry.');
      const relative = safeRelative(name.slice(5));
      const target = contained(destination, relative);
      if (++actualFiles.length > ARCHIVE_LIMITS.files) throw new Error('Archive has too many files.');
      const index = actualFiles.length - 1;
      await mkdir(path.dirname(target), { recursive: true });
      const digest = createHash('sha256'); let length = 0;
      const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        length += chunk.length; total += chunk.length;
        if (length > ARCHIVE_LIMITS.fileBytes || total > ARCHIVE_LIMITS.totalBytes || length > entry.uncompressedSize) { callback(new Error('Expanded archive exceeds the limit.')); return; }
        digest.update(chunk); callback(null, chunk);
      } });
      await pipeline(await zip.openReadStreamPromise(entry), guard, createWriteStream(target, { flags: 'wx' }), { signal });
      if (length !== entry.uncompressedSize) throw new Error('ZIP entry size mismatch.');
      actualFiles[index] = { path: relative, size: length, sha256: digest.digest('hex') };
    }
    if (manifest === undefined) throw new Error('Archive manifest is missing.');
    const observed = new Map(actualFiles.map(file => [file.path, file]));
    if (actualFiles.length !== manifest.files.length || manifest.files.some(file => {
      const actual = observed.get(file.path);
      return actual === undefined || actual.size !== file.size || actual.sha256 !== file.sha256;
    })) throw new Error('Archive file inventory failed verification.');
    return await validateSealedDirectory(destination, manifest, signal);
  } finally { zip.close(); }
}
