/** Integrity-checked gzip package format for complete portable Vault transfer. */

import { createHash } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { AgentVaultError } from '@deepseek-ai/dsh-agent-vault'

const zip = promisify(gzip)
const unzip = promisify(gunzip)
const MAX_FILES = 200_000
const MAX_BYTES = 4 * 1024 * 1024 * 1024

interface ArchiveEntry { readonly path: string; readonly bytes: number; readonly sha256: string; readonly data: string }
interface Archive { readonly format: 'worldline-agent-vault-package'; readonly version: 1; readonly agentId: string; readonly shareable: boolean; readonly entries: readonly ArchiveEntry[] }

const digest = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

function archiveRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseArchive(value: unknown): Archive {
  const record = archiveRecord(value)
  if (record === undefined || record['format'] !== 'worldline-agent-vault-package'
    || record['version'] !== 1 || typeof record['agentId'] !== 'string'
    || typeof record['shareable'] !== 'boolean' || !Array.isArray(record['entries'])) {
    throw new AgentVaultError('Agent Vault package format is unsupported.', 'IMPORT_REJECTED')
  }
  const entries: ArchiveEntry[] = record['entries'].map((value: unknown) => {
    const entry = archiveRecord(value)
    if (entry === undefined || typeof entry['path'] !== 'string' || typeof entry['bytes'] !== 'number'
      || typeof entry['sha256'] !== 'string' || typeof entry['data'] !== 'string') {
      throw new AgentVaultError('Agent Vault package entry is malformed.', 'IMPORT_REJECTED')
    }
    return { path: entry['path'], bytes: entry['bytes'], sha256: entry['sha256'], data: entry['data'] }
  })
  return { format: record['format'], version: record['version'], agentId: record['agentId'],
    shareable: record['shareable'], entries }
}

async function writeBinaryAtomic(target: string, data: Uint8Array): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
  await rename(temporary, target)
}

async function files(root: string, shareable: boolean): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const rel = relative(root, path).replaceAll('\\', '/')
      if (rel === '.system' || rel.startsWith('.system/')) continue
      if (shareable && (rel.startsWith('self/emotion') || rel.startsWith('self/state')
        || rel.startsWith('self/relationships-private') || rel.startsWith('memory/short/'))) continue
      if (entry.isSymbolicLink()) throw new AgentVaultError('Vault packages cannot contain symbolic links.', 'IMPORT_REJECTED')
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) found.push(path)
    }
  }
  await walk(root)
  return found.sort()
}

/**
 * Package one Vault with per-file integrity metadata.
 * @param root - Vault root.
 * @param agentId - Vault identity.
 * @param target - Package target.
 * @param shareable - Exclude transient private state.
 * @returns Package report.
 */
export async function pack(root: string, agentId: string, target: string,
  shareable: boolean): Promise<{ files: number; bytes: number; sha256: string }> {
  const paths = await files(root, shareable)
  const entries: ArchiveEntry[] = []
  let bytes = 0
  for (const path of paths) {
    const data = await readFile(path)
    bytes += data.byteLength
    entries.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: data.byteLength,
      sha256: digest(data), data: data.toString('base64') })
  }
  const encoded = Buffer.from(JSON.stringify({ format: 'worldline-agent-vault-package', version: 1,
    agentId, shareable, entries } satisfies Archive))
  const compressed = await zip(encoded, { level: 9 })
  await writeFileAtomic(target, compressed.toString('base64'), { mode: 0o600, dirMode: 0o700 })
  return { files: entries.length, bytes, sha256: digest(compressed) }
}

/**
 * Verify and unpack into an isolated staging root.
 * @param packageFile - Package source.
 * @param stagingRoot - Empty staging root.
 * @returns Import report.
 */
export async function unpack(packageFile: string,
  stagingRoot: string): Promise<{ agentId: string; files: number; bytes: number; sha256: string }> {
  const encoded = await readFile(packageFile, 'utf8')
  const compressed = Buffer.from(encoded, 'base64')
  let archive: Archive
  try { archive = parseArchive(JSON.parse((await unzip(compressed)).toString('utf8')) as unknown) }
  catch (error) { throw new AgentVaultError('Agent Vault package is malformed.', 'IMPORT_REJECTED', undefined, { cause: error }) }
  if (archive.entries.length > MAX_FILES) throw new AgentVaultError('Agent Vault package has too many files.', 'IMPORT_REJECTED')
  let bytes = 0
  const seen = new Set<string>()
  for (const entry of archive.entries) {
    if (typeof entry.path !== 'string' || entry.path === '' || entry.path.startsWith('/')
      || /^[a-z]:/iu.test(entry.path)
      || entry.path.split('/').some((part: string) => part === '' || part === '.' || part === '..')) {
      throw new AgentVaultError('Agent Vault package contains an unsafe path.', 'IMPORT_REJECTED')
    }
    if (seen.has(entry.path)) throw new AgentVaultError('Agent Vault package repeats a path.', 'IMPORT_REJECTED')
    seen.add(entry.path)
    const data = Buffer.from(entry.data, 'base64')
    bytes += data.byteLength
    if (bytes > MAX_BYTES || data.byteLength !== entry.bytes || digest(data) !== entry.sha256) {
      throw new AgentVaultError('Agent Vault package integrity check failed.', 'INTEGRITY_FAILED')
    }
    const target = join(stagingRoot, ...entry.path.split('/'))
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeBinaryAtomic(target, data)
  }
  return { agentId: archive.agentId, files: archive.entries.length, bytes, sha256: digest(compressed) }
}
