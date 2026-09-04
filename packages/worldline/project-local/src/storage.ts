import { createHash, randomUUID } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { WORLDLINE_PROJECT_LAYOUT, type Revision } from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineProjectError } from '@deepseek-ai/dsh-worldline-project'

/** Identifies the package-owned control directory value.
 */
export const CONTROL_DIRECTORY = WORLDLINE_PROJECT_LAYOUT.control.root
/** Identifies the package-owned max text bytes value.
 */
export const MAX_TEXT_BYTES = 20 * 1024 * 1024

/** Perform message of through the package's public contract.
 * @param error - The error supplied by the caller.
 * @returns The result produced by the operation.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Perform is inside through the package's public contract.
 * @param root - The root supplied by the caller.
 * @param candidate - The candidate supplied by the caller.
 * @returns The result produced by the operation.
 */
export function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Perform normalize relative through the package's public contract.
 * @param path - The path supplied by the caller.
 * @returns The result produced by the operation.
 */
export function normalizeRelative(path: string): string {
  const value = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  if (value === '') return ''
  if (value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new WorldlineProjectError('path-invalid', `invalid project-relative path: ${path}`)
  }
  if (isAbsolute(path) || /^[a-z]:/i.test(path)) {
    throw new WorldlineProjectError('path-invalid', `project path must be relative: ${path}`)
  }
  return value
}

/** Read resolve inside from the package-owned authoritative state.
 * @param root - The root supplied by the caller.
 * @param path - The path supplied by the caller.
 * @returns The result produced by the operation.
 */
export function resolveInside(root: string, path: string): string {
  const normalized = normalizeRelative(path)
  const target = resolve(root, ...normalized.split('/').filter(Boolean))
  if (!isInside(root, target)) {
    throw new WorldlineProjectError('path-outside-project', `path escapes the project: ${path}`)
  }
  return target
}

/** Perform assert no symlink through the package's public contract.
 * @param root - The root supplied by the caller.
 * @param target - The target supplied by the caller.
 * @param allowMissingLeaf - The allow missing leaf supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function assertNoSymlink(root: string, target: string, allowMissingLeaf = false): Promise<void> {
  const rel = relative(root, target)
  if (!isInside(root, target)) {
    throw new WorldlineProjectError('path-outside-project', `path escapes the project: ${target}`)
  }
  let current = root
  const segments = rel === '' ? [] : rel.split(sep)
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === undefined) continue
    current = resolve(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new WorldlineProjectError('path-outside-project', `symbolic links are not writable: ${current}`)
      }
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' && (allowMissingLeaf || index < segments.length - 1)) continue
      throw error
    }
  }
}

/** Perform revision of through the package's public contract.
 * @param content - The content supplied by the caller.
 * @returns The result produced by the operation.
 */
export function revisionOf(content: string | Uint8Array): Revision {
  return `sha256:${createHash('sha256').update(content).digest('hex')}` as Revision
}

/** Perform durable write through the package's public contract.
 * @param path - The path supplied by the caller.
 * @param content - The content supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function durableWrite(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await rename(temporary, path)
    try {
      const parent = await open(dirname(path), 'r')
      try { await parent.sync() } finally { await parent.close() }
    } catch {
      // Windows and some network filesystems do not expose directory fsync.
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** Perform durable write stream through the package's public contract.
 * @param path - The path supplied by the caller.
 * @param source - The source supplied by the caller.
 * @param expectedBytes - The expected bytes supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function durableWriteStream(
  path: string,
  source: AsyncIterable<Uint8Array>,
  expectedBytes: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  let written = 0
  try {
    for await (const chunk of source) {
      written += chunk.byteLength
      if (written > expectedBytes) throw new RangeError('stream exceeds declared file length')
      let offset = 0
      while (offset < chunk.byteLength) {
        const result = await file.write(chunk, offset, chunk.byteLength - offset)
        if (result.bytesWritten === 0) throw new Error('streamed import made no write progress')
        offset += result.bytesWritten
      }
    }
    if (written !== expectedBytes) throw new RangeError(`stream ended at ${String(written)} of ${String(expectedBytes)} bytes`)
    await file.sync()
  } catch (error) {
    await file.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  await file.close()
  try {
    await rename(temporary, path)
    try {
      const parent = await open(dirname(path), 'r')
      try { await parent.sync() } finally { await parent.close() }
    } catch {
      // Windows and some network filesystems do not expose directory fsync.
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** Read bounded UTF-8 text from the authoritative local project store.
 * @param path - The path supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function readTextBounded(path: string): Promise<string> {
  const info = await stat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorldlineProjectError('entry-not-found', `document does not exist: ${path}`)
    }
    throw error
  })
  if (!info.isFile()) throw new WorldlineProjectError('path-invalid', `not a document: ${path}`)
  if (info.size > MAX_TEXT_BYTES) {
    throw new WorldlineProjectError('entry-too-large', `document exceeds ${String(MAX_TEXT_BYTES)} bytes`)
  }
  return readFile(path, 'utf8')
}

/** Perform exists through the package's public contract.
 * @param path - The path supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(() => true, () => false)
}

/** Copy a file durably without exposing partial destination content.
 * @param source - The source supplied by the caller.
 * @param destination - The destination supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function copyFileDurable(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  const file = await open(destination, 'r+')
  try { await file.sync() } finally { await file.close() }
}

/** Describes the walk entry value exchanged across the package boundary.
 */
export interface WalkEntry { readonly relativePath: string; readonly dirent: Dirent }

/** Perform walk through the package's public contract.
 * @param root - The root supplied by the caller.
 * @param includeControl - The include control supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function walk(root: string, includeControl = false): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = []
  const visit = async (directory: string): Promise<void> => {
    const rows = await readdir(directory, { withFileTypes: true })
    rows.sort((left, right) => left.name.localeCompare(right.name))
    for (const dirent of rows) {
      if (!includeControl && dirent.name === CONTROL_DIRECTORY) continue
      const absolute = resolve(directory, dirent.name)
      const relativePath = relative(root, absolute).split(sep).join('/')
      if (dirent.isSymbolicLink()) continue
      entries.push({ relativePath, dirent })
      if (dirent.isDirectory()) await visit(absolute)
    }
  }
  await visit(root)
  return entries
}

/** Perform directory size through the package's public contract.
 * @param root - The root supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function directorySize(root: string): Promise<number> {
  let bytes = 0
  for (const entry of await walk(root, true)) {
    if (entry.dirent.isFile()) bytes += (await stat(resolveInside(root, entry.relativePath))).size
  }
  return bytes
}

/** Perform canonical root through the package's public contract.
 * @param path - The path supplied by the caller.
 * @param create - The create supplied by the caller.
 * @returns The result produced by the operation.
 */
export async function canonicalRoot(path: string, create = true): Promise<string> {
  const root = resolve(path)
  if (!isAbsolute(root)) throw new WorldlineProjectError('root-unreadable', 'root must be absolute')
  if (create) await mkdir(root, { recursive: true })
  else if (!(await exists(root))) {
    throw new WorldlineProjectError('root-unreadable', `root does not exist: ${path}`)
  }
  const canonical = await realpath(root)
  const info = await stat(canonical)
  if (!info.isDirectory()) throw new WorldlineProjectError('root-unreadable', `not a directory: ${path}`)
  return canonical
}
