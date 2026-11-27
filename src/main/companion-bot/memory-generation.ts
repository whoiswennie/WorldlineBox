import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, readFile, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

/** The live engine has a separate home. A locked legacy database must never
 * decide whether a companion can receive a message in the new generation. */
export function openNativeMemoryGeneration(profileDirectory: string) {
  const root = path.resolve(profileDirectory, 'companion-bot-v2', 'vcp-memory-v5');
  return { root, retirement: retireLegacyDirectories(profileDirectory) };
}

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const invalidDirectory = () => new Error('旧版伙伴记忆目录不是应用资料目录中的实体目录。');

async function physicalDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, path.toNamespacedPath(await realpath(directory))) !== '') throw invalidDirectory();
    return true;
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
    return false;
  }
}

async function hasReceipt(filename: string): Promise<boolean> {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('旧版记忆清理回执无效。');
    return true;
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
    return false;
  }
}

async function once(filename: string, clean: () => Promise<void>): Promise<void> {
  if (await hasReceipt(filename)) return;
  await clean();
  try { await (await open(filename, 'wx')).close(); } catch (error) {
    if (codeOf(error) !== 'EEXIST' || !await hasReceipt(filename)) throw error;
  }
}

async function removeEmpty(directory: string): Promise<void> {
  try { await rmdir(directory); } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(codeOf(error) || '')) throw error;
  }
}

async function removeDshReceipts(directory: string, prefix: RegExp): Promise<void> {
  if (!await physicalDirectory(directory)) return;
  for await (const entry of await opendir(directory)) {
    // The DSH bridge derives each final receipt's filename from the event ID.
    // A matching directory or a .json extension alone does not prove ownership.
    if (!/^[0-9a-f]{64}\.json$/u.test(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    const stat = await lstat(filename);
    if (stat.isSymbolicLink()) throw invalidDirectory();
    if (!stat.isFile()) continue;
    let eventId: unknown;
    try { eventId = JSON.parse(await readFile(filename, 'utf8'))?.eventId; } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (typeof eventId === 'string' && prefix.test(eventId) && createHash('sha256').update(eventId).digest('hex') + '.json' === entry.name) await unlink(filename);
  }
  await removeEmpty(directory);
}

async function visitKnownDirectories(directory: string, names: RegExp, visit: (directory: string) => Promise<void>): Promise<void> {
  if (!await physicalDirectory(directory)) return;
  for await (const entry of await opendir(directory)) {
    if (!names.test(entry.name)) continue;
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw invalidDirectory();
    if (!entry.isDirectory() || !await physicalDirectory(child)) continue;
    await visit(child);
    await removeEmpty(child);
  }
  await removeEmpty(directory);
}

async function retireEncoder(companion: string): Promise<void> {
  const encoder = path.join(companion, 'memory-encoder');
  if (!await physicalDirectory(encoder)) return;
  await removeDshReceipts(path.join(encoder, '.worldlinebox-brain'), /^capture-(?:v3-)?memory-/u);
  await removeEmpty(encoder);
}

async function finishIndependent(cleanups: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(cleanups);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function retireWork(companion: string): Promise<void> {
  const hash = /^[0-9a-f]{64}$/u;
  await finishIndependent([
    retireEncoder(companion),
    visitKnownDirectories(path.join(companion, 'memory-maintenance'), hash, audience =>
      visitKnownDirectories(audience, /^maintenance-[0-9a-f]{64}$/u, job =>
        removeDshReceipts(path.join(job, '.worldlinebox-brain'), /^memory-maintenance-/u))),
    visitKnownDirectories(path.join(companion, 'memory-review'), hash, review =>
      removeDshReceipts(path.join(review, '.worldlinebox-brain'), /^memory-review-/u)),
  ]);
}

async function retireIndex(companion: string): Promise<void> {
  const previous = ['memory', path.join('memory-encoder', 'capture-plans'), path.join('memory-encoder', 'capture-results')];
  await finishIndependent(previous.map(async name => {
    const directory = path.join(companion, name);
    if (!await physicalDirectory(path.dirname(directory)) || !await physicalDirectory(directory)) return;
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }));
}

const retiring = new Map<string, Promise<void>>();
function retireLegacyDirectories(profileDirectory: string): Promise<void> {
  const absolute = path.resolve(profileDirectory);
  const active = retiring.get(absolute);
  if (active) return active;
  const retirement = retireProfile(absolute).finally(() => retiring.delete(absolute));
  retiring.set(absolute, retirement);
  return retirement;
}

async function retireProfile(directory: string): Promise<void> {
  if ((await lstat(directory)).isSymbolicLink()) throw invalidDirectory();
  const profile = path.toNamespacedPath(await realpath(directory));
  const companion = path.join(profile, 'companion-bot-v2');
  await mkdir(companion, { recursive: true });
  if (!await physicalDirectory(companion)) throw invalidDirectory();
  // Each stage commits independently. A locked old index cannot prevent the
  // second stage from retiring its queue receipts, or revoke a previous marker.
  let indexError: unknown;
  try { await once(path.join(companion, '.vcp-v5-legacy-memory-retired'), () => retireIndex(companion)); }
  catch (error) { indexError = error; }
  await once(path.join(companion, '.vcp-v5-legacy-work-retired'), () => retireWork(companion));
  if (indexError) throw indexError;
}
