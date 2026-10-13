import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdCompress, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { copyFile, createReadStream, createWriteStream, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from './disk';
import { atomicJson, contained, hashFile, inventoryTree, removeManaged, safeRelative } from './files';
import { dshProjectKey, firstSessionFrameEnd } from './instance-data-rebase';
import { supportsSharedDataRuntime } from './validated-runtime';

const VERIFIED_RUNTIME = '0.2.0-rc.2';
const HEADER_LIMIT = 4 * 1024 ** 2;
const MAX_FILES = 150_000;
const MAX_BYTES = 6 * 1024 ** 3;
const compress = (bytes: Buffer) => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export interface SharedSessionDataPaths {
  rootPath: string; sessionsPath: string; documentsPath: string; workspacePath: string;
  credentialsPath: string; settingsPath: string; attachmentsPath: string;
}
export function sharedDataPaths(sharedRoot: string): SharedSessionDataPaths {
  const rootPath = path.resolve(sharedRoot); const documentsPath = path.join(rootPath, 'documents');
  return { rootPath, documentsPath, sessionsPath: path.join(rootPath, 'sessions'),
    workspacePath: path.join(documentsPath, 'deepseek-harness', 'default-workspace'),
    credentialsPath: path.join(rootPath, '.credentials.yaml'), settingsPath: path.join(rootPath, 'model-settings.json'),
    attachmentsPath: path.join(rootPath, 'attachments', 'v1') };
}
export interface SharedSessionRoutingPatch { id: string; config: Record<string, string> }
/** Final launcher-owned --patch rows; DSH_HOME and storage-json stay private. */
export function sharedSessionRoutingPatches(sharedRoot: string): SharedSessionRoutingPatch[] {
  const paths = sharedDataPaths(sharedRoot);
  return [
    { id: 'session-persistence-jsonl', config: { root: paths.sessionsPath, compression: 'zstd' } },
    { id: 'attachment-local', config: { dshHome: paths.rootPath } },
    { id: 'workspace-controller', config: { documentsDirectory: paths.documentsPath } },
  ];
}

interface FileEntry { file: string; relative: string; size: number }
interface SessionHeader {
  type: 'session'; version: number; id: string; createdAt: number; delegationDepth: number; cwd?: string;
  [key: string]: unknown;
}
interface SessionLog extends FileEntry { header: SessionHeader; offset: number; compressed: boolean; filename: string }
interface SessionGroup { directory: string; relative: string; header: SessionHeader; logs: SessionLog[] }
interface WorkspaceDocument {
  file: string; bytes: Buffer; value: Record<string, unknown>; defaultDirectories: string[];
}

async function statIfPresent(file: string) {
  return lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
}
async function ensureDirectory(root: string, directory: string): Promise<void> {
  if (!inside(root, directory)) throw new Error('Shared data path escapes its owned root.');
  const relative = path.relative(root, directory); let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stats = await statIfPresent(current);
    if (stats && (stats.isSymbolicLink() || !stats.isDirectory())) throw new Error('Shared data refuses linked or non-directory paths.');
    if (!stats) await mkdir(current, { recursive: segment === '' });
  }
}
async function filesUnder(root: string, signal?: AbortSignal): Promise<FileEntry[]> {
  if (!await statIfPresent(root)) return [];
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Shared data migration refuses linked roots.');
  const canonical = await realpath(root); const files: FileEntry[] = []; let entries = 0; let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted(); if (++entries > MAX_FILES) throw new Error('Too many shared data migration entries.');
      const file = path.join(directory, entry.name); const relative = path.relative(root, file).replaceAll('\\', '/');
      safeRelative(relative); const stats = await lstat(file);
      if (stats.isSymbolicLink() || !inside(canonical, await realpath(file))) throw new Error('Shared data migration refuses linked or escaping data.');
      if (stats.isDirectory()) { await walk(file); continue; }
      if (!stats.isFile()) throw new Error('Shared data migration found an unsupported file.');
      bytes += stats.size; if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) throw new Error('Shared data migration exceeds 6 GiB.');
      files.push({ file, relative, size: stats.size });
    }
  };
  await walk(root); return files;
}
function sessionSegment(id: string): string {
  if (id === '.' || id === '..') return id.split('').map(() => '~002E').join('');
  let encoded = '';
  for (let index = 0; index < id.length; index++) {
    const character = id[index]!;
    encoded += character !== '~' && /^[A-Za-z0-9._-]$/.test(character) ? character : `~${id.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return encoded;
}
function sessionRelative(header: SessionHeader): string {
  return `${header.cwd === undefined ? '_no-cwd' : dshProjectKey(header.cwd)}/${sessionSegment(header.id)}`;
}
function parseHeader(bytes: Buffer, version: number): SessionHeader {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid shared Session header.');
  const header = value as SessionHeader;
  if (version > 4 || header.version !== version) throw new Error('Unsupported shared Session schema; existing data will not be written.');
  const keys = new Set(['type', 'version', 'id', 'createdAt', 'delegationDepth', 'cwd', 'parentSession', 'origin', 'agentPreset', version < 2 ? 'seedLength' : 'isSeeded']);
  if (header.type !== 'session' || typeof header.id !== 'string' || !header.id || header.id.length > 16_384
    || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0 || Object.is(header.createdAt, -0)
    || !Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0 || Object.is(header.delegationDepth, -0)
    || (header.cwd !== undefined && (typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)))
    || Object.keys(header).some(key => !keys.has(key))
    || (version >= 2 && typeof header.isSeeded !== 'boolean')
    || (version < 2 && header.seedLength !== undefined && (!Number.isSafeInteger(header.seedLength) || (header.seedLength as number) < 0))
    || (header.origin !== undefined && header.origin !== 'subagent')
    || ['parentSession', 'agentPreset'].some(key => header[key] !== undefined && typeof header[key] !== 'string')) throw new Error('Unsupported shared Session header fields.');
  return header;
}
async function inspectLog(file: FileEntry, version: number, compressed: boolean): Promise<SessionLog> {
  const handle = await open(file.file, 'r');
  try {
    let size = Math.min(file.size, 64 * 1024); let offset = 0; let prefix = Buffer.alloc(0);
    for (;;) {
      prefix = Buffer.alloc(size); const result = await handle.read(prefix, 0, size, 0); prefix = prefix.subarray(0, result.bytesRead);
      try { offset = compressed ? firstSessionFrameEnd(prefix) : prefix.indexOf(10) + 1; }
      catch (error) { if (!(error instanceof Error) || !error.message.startsWith('Truncated')) throw error; }
      if (offset > 0) break;
      if (size >= Math.min(file.size, HEADER_LIMIT)) throw new Error('Truncated or oversized shared Session header.');
      size = Math.min(file.size, HEADER_LIMIT, size * 2);
    }
    const bytes = compressed ? zstdDecompressSync(prefix.subarray(0, offset), { maxOutputLength: HEADER_LIMIT }) : prefix.subarray(0, offset);
    if (bytes.indexOf(10) !== bytes.length - 1) throw new Error('Shared Session header must occupy exactly one line.');
    const header = parseHeader(bytes, version);
    return { ...file, header, offset, compressed, filename: `session${version ? `.v${version}` : ''}.jsonl.zstd` };
  } finally { await handle.close(); }
}
async function sessionGroups(root: string, signal?: AbortSignal): Promise<SessionGroup[]> {
  const groups = new Map<string, SessionGroup>();
  for (const file of await filesUnder(root, signal)) {
    const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/.exec(path.basename(file.file));
    if (!match) {
      if (path.basename(file.file).startsWith('session') && /\.jsonl(?:\.zstd)?$/.test(file.file)) throw new Error('Unsupported shared Session filename.');
      continue;
    }
    const version = match[1] === undefined ? 0 : Number(match[1]);
    if (!Number.isSafeInteger(version) || version > 4) throw new Error('Unsupported shared Session schema; existing data will not be written.');
    const log = await inspectLog(file, version, !!match[2]); const directory = path.dirname(file.file);
    const relative = path.relative(root, directory).replaceAll('\\', '/');
    if (relative !== sessionRelative(log.header)) throw new Error('Shared Session identity does not match its canonical directory.');
    const earlier = groups.get(directory);
    if (earlier && (earlier.header.id !== log.header.id || earlier.header.cwd !== log.header.cwd)) throw new Error('Shared Session generations disagree about their identity.');
    if (earlier) earlier.logs.push(log); else groups.set(directory, { directory, relative, header: log.header, logs: [log] });
  }
  const identities = new Set<string>();
  for (const group of groups.values()) {
    if (identities.has(group.header.id)) throw new Error('Duplicate shared Session identities are unsafe to merge.');
    identities.add(group.header.id);
  }
  return [...groups.values()];
}

/** Reader/writer ABI gate; the upstream backend enforces its per-session kernel lease. */
export async function assertSharedSessionCompatibility(sharedRoot: string, runtimeVersion = VERIFIED_RUNTIME, signal?: AbortSignal): Promise<void> {
  const paths = sharedDataPaths(sharedRoot); const groups = await sessionGroups(paths.sessionsPath, signal);
  if (groups.length && !supportsSharedDataRuntime(runtimeVersion)) throw new Error('This runtime has no verified shared Session reader/writer adapter. Existing data will not be written.');
  if (groups.some(group => group.logs.some(log => !log.compressed))) throw new Error('Shared Session storage must use the verified Zstandard encoding.');
  const attachmentRoot = path.join(paths.rootPath, 'attachments');
  if (await statIfPresent(attachmentRoot)) for (const entry of await readdir(attachmentRoot)) if (entry !== 'v1') throw new Error('Unsupported shared attachment schema.');
}
export async function prepareSharedSessionData(sharedRoot: string, runtimeVersion = VERIFIED_RUNTIME): Promise<SharedSessionDataPaths> {
  const paths = sharedDataPaths(sharedRoot);
  await assertSharedSessionCompatibility(sharedRoot, runtimeVersion);
  for (const directory of [paths.rootPath, paths.sessionsPath, paths.workspacePath, paths.attachmentsPath]) await ensureDirectory(paths.rootPath, directory);
  return paths;
}

async function workspaceDocument(homePath: string, instanceRoot: string): Promise<WorkspaceDocument | undefined> {
  const file = path.join(homePath, 'storages', 'workspace.json'); const stats = await statIfPresent(file); if (!stats) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 32 * 1024 ** 2) throw new Error('Unsupported private Workspace metadata.');
  const bytes = await readFile(file); const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid private Workspace metadata.');
  const value = parsed as Record<string, unknown>; const unit = value.unit as Record<string, unknown> | undefined;
  const global = value.global as Record<string, unknown> | undefined; const tables = value.tables as Record<string, unknown> | undefined;
  const records = tables?.workspaces;
  if (unit?.name !== 'workspace' || unit.version !== 2 || !global || typeof global.initialized !== 'boolean'
    || !Array.isArray(global.workspaceIds) || global.workspaceIds.some(id => typeof id !== 'string')
    || !records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Unsupported Workspace storage schema; existing data will not be written.');
  const defaultDirectories: string[] = [];
  for (const [id, raw] of Object.entries(records)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Workspace record.');
    const row = raw as Record<string, unknown>;
    if (typeof row.path !== 'string' || !path.isAbsolute(row.path) || typeof row.title !== 'string'
      || !Array.isArray(row.sessionIds) || row.sessionIds.some(session => typeof session !== 'string')
      || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') throw new Error('Invalid Workspace record.');
    if (inside(instanceRoot, row.path) && (id === global.defaultWorkspaceId || /[\\/]deepseek-harness[\\/]default-workspace[\\/]?$/.test(row.path))) defaultDirectories.push(row.path);
  }
  return { file, bytes, value, defaultDirectories };
}
/** Check save presence without opening credentials, profile configuration or plugins. */
export async function hasPrivateSaveData(homePath: string, workspacePath: string): Promise<boolean> {
  const instanceRoot = path.dirname(path.resolve(homePath));
  if ((await filesUnder(path.join(homePath, 'sessions'))).some(file => /\.jsonl(?:\.zstd)?$/.test(file.relative))) return true;
  if ((await filesUnder(path.join(homePath, 'attachments', 'v1'))).length) return true;
  const registry = await workspaceDocument(homePath, instanceRoot);
  const roots = [...new Set([workspacePath, ...registry?.defaultDirectories ?? [],
    path.join(instanceRoot, 'user', 'Documents', 'deepseek-harness', 'default-workspace')])];
  for (const root of roots) if ((await filesUnder(root)).length) return true;
  return false;
}
function remapCwd(cwd: string | undefined, oldRoots: string[], target: string): string | undefined {
  if (cwd === undefined) return undefined;
  const root = oldRoots.find(old => inside(old, cwd));
  return root === undefined ? cwd : path.join(target, path.relative(root, cwd));
}
async function relocateLog(log: SessionLog, destination: string, cwd: string | undefined, signal?: AbortSignal): Promise<void> {
  const header = Buffer.from(`${JSON.stringify({ ...log.header, ...(cwd === undefined ? {} : { cwd }) })}\n`);
  await writeFile(destination, compress(header), { flag: 'wx' });
  if (log.size <= log.offset) return;
  const input = createReadStream(log.file, { start: log.offset }); const output = createWriteStream(destination, { flags: 'a' });
  if (log.compressed) await pipeline(input, output, { signal });
  else await pipeline(input, createZstdCompress({ params: { [constants.ZSTD_c_checksumFlag]: 1 } }), output, { signal });
}
async function sameFile(source: string, destination: string, signal?: AbortSignal): Promise<boolean> {
  const stats = await statIfPresent(destination); if (!stats?.isFile() || stats.isSymbolicLink()) return false;
  if (stats.size !== (await lstat(source)).size) return false;
  return await hashFile(source, signal) === await hashFile(destination, signal);
}

export interface SharedSessionMigrationReport {
  copiedSessions: number; conflictingSessions: number; copiedWorkspaceFiles: number; conflictingWorkspaceFiles: number;
  copiedAttachments: number; conflictingAttachments: number; workspaceRegistryRebased: boolean; archivePath?: string;
}
/** Caller must stop every managed Host before migration/backup merge, never merely this instance. */
export async function migrateInstanceData(options: {
  instanceId: string; homePath: string; workspacePath: string; sharedRoot: string;
  oldWorkspacePath?: string; runtimeVersion?: string; signal?: AbortSignal;
}): Promise<SharedSessionMigrationReport> {
  if (!/^[a-z0-9-]{1,80}$/.test(options.instanceId)) throw new Error('Invalid shared data migration instance ID.');
  const { signal } = options; const paths = sharedDataPaths(options.sharedRoot); const sourceHome = path.resolve(options.homePath);
  if (inside(paths.rootPath, sourceHome) || inside(sourceHome, paths.rootPath)) throw new Error('Shared data migration requires a separate private source.');
  const instanceRoot = path.dirname(sourceHome); const registry = await workspaceDocument(sourceHome, instanceRoot);
  const workspaceRoots = [...new Set([path.resolve(options.workspacePath), ...registry?.defaultDirectories ?? [],
    path.join(instanceRoot, 'user', 'Documents', 'deepseek-harness', 'default-workspace')])];
  const mappedRoots = [...new Set([...(options.oldWorkspacePath ? [path.resolve(options.oldWorkspacePath)] : []), ...workspaceRoots])].sort((a, b) => b.length - a.length);
  const groups = await sessionGroups(path.join(sourceHome, 'sessions'), signal);
  const existingGroups = await sessionGroups(paths.sessionsPath, signal);
  if ((groups.length || existingGroups.length) && !supportsSharedDataRuntime(options.runtimeVersion ?? VERIFIED_RUNTIME)) throw new Error('This runtime has no verified shared Session migration adapter.');
  await assertSharedSessionCompatibility(paths.rootPath, options.runtimeVersion ?? VERIFIED_RUNTIME, signal);
  const workspaces = await Promise.all(workspaceRoots.map(async root => ({ root, files: await filesUnder(root, signal) })));
  const attachmentsRoot = path.join(sourceHome, 'attachments');
  if (await statIfPresent(attachmentsRoot)) for (const entry of await readdir(attachmentsRoot)) if (entry !== 'v1') throw new Error('Unsupported source attachment schema.');
  const attachments = await filesUnder(path.join(attachmentsRoot, 'v1'), signal);
  // All generations, Workspace schema and source paths are checked before any
  // publication. Original conversations and working files are never removed.
  await prepareSharedSessionData(paths.rootPath, options.runtimeVersion ?? VERIFIED_RUNTIME);
  const lock = path.join(paths.rootPath, '.session-migration.lock');
  try { await mkdir(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Shared data migration is already running or was interrupted; retain its archive and recover the migration lock before retrying.', { cause: error }); throw error; }
  const temporary = path.join(paths.rootPath, 'migration-staging', randomUUID());
  const archive = path.join(paths.rootPath, 'migration-archives', options.instanceId, randomUUID());
  const report: SharedSessionMigrationReport = { copiedSessions: 0, conflictingSessions: 0, copiedWorkspaceFiles: 0, conflictingWorkspaceFiles: 0, copiedAttachments: 0, conflictingAttachments: 0, workspaceRegistryRebased: false };
  let archived = false;
  const archiveFile = async (source: string, relative: string): Promise<void> => {
    const target = contained(archive, safeRelative(relative)); await ensureDirectory(paths.rootPath, path.dirname(target));
    await copyFile(source, target, fsConstants.COPYFILE_EXCL); archived = true;
  };
  try {
    await ensureDirectory(paths.rootPath, temporary);
    for (const group of groups) {
      signal?.throwIfAborted(); const cwd = remapCwd(group.header.cwd, mappedRoots, paths.workspacePath);
      const nextHeader = { ...group.header, ...(cwd === undefined ? {} : { cwd }) }; const relative = sessionRelative(nextHeader);
      const staged = contained(temporary, relative); await ensureDirectory(paths.rootPath, staged);
      for (const log of group.logs) await relocateLog(log, path.join(staged, log.filename), cwd, signal);
      const destination = contained(paths.sessionsPath, relative);
      const sameId = existingGroups.find(value => value.header.id === group.header.id);
      if (sameId || await statIfPresent(destination)) {
        const identical = sameId?.relative === relative && (await inventoryTree(staged, signal)).contentSha256 === (await inventoryTree(destination, signal)).contentSha256;
        if (!identical) {
          report.conflictingSessions++;
          for (const file of await filesUnder(group.directory, signal)) if (path.basename(file.file) !== 'session.lock') await archiveFile(file.file, `sessions/${group.relative}/${file.relative}`);
        }
        continue;
      }
      await ensureDirectory(paths.rootPath, path.dirname(destination));
      await rename(staged, destination); report.copiedSessions++;
      existingGroups.push({ ...group, relative, directory: destination, header: nextHeader });
    }
    const mergeFiles = async (files: FileEntry[], destinationRoot: string, category: 'WorkspaceFiles' | 'Attachments', prefix: string): Promise<void> => {
      for (const file of files) {
        signal?.throwIfAborted(); const target = contained(destinationRoot, file.relative);
        await ensureDirectory(paths.rootPath, path.dirname(target));
        const present = await statIfPresent(target);
        if (present) {
          if (present.isSymbolicLink()) throw new Error('Shared data migration refuses linked destinations.');
          if (!await sameFile(file.file, target, signal)) { report[`conflicting${category}`]++; await archiveFile(file.file, `${prefix}/${file.relative}`); }
        } else { await copyFile(file.file, target, fsConstants.COPYFILE_EXCL); report[`copied${category}`]++; }
      }
    };
    for (let index = 0; index < workspaces.length; index++) await mergeFiles(workspaces[index]!.files, paths.workspacePath, 'WorkspaceFiles', `workspace-${index}`);
    await mergeFiles(attachments, paths.attachmentsPath, 'Attachments', 'attachments/v1');
    if (registry) {
      const records = (registry.value.tables as { workspaces: Record<string, { path: string }> }).workspaces;
      for (const record of Object.values(records)) {
        const next = remapCwd(record.path, mappedRoots, paths.workspacePath)!;
        if (next !== record.path) { record.path = next; report.workspaceRegistryRebased = true; }
      }
      if (report.workspaceRegistryRebased) { await archiveFile(registry.file, 'workspace-registry.json'); await atomicJson(registry.file, registry.value); }
    }
    if (archived) report.archivePath = archive;
    await ensureDirectory(paths.rootPath, path.join(paths.rootPath, 'migration-receipts'));
    await atomicJson(path.join(paths.rootPath, 'migration-receipts', `${options.instanceId}.json`), {
      format: 'worldlinebox-shared-session-migration-v1', instanceId: options.instanceId, createdAt: new Date().toISOString(), ...report,
      sourceHomePath: sourceHome, workspaceRoots, targetWorkspacePath: paths.workspacePath,
      sourceFingerprint: createHash('sha256').update(JSON.stringify(groups.map(group => [group.relative, group.logs.map(log => [log.relative, log.size, log.header])]))).digest('hex'),
    });
    return report;
  } finally {
    await removeManaged(paths.rootPath, temporary); await removeManaged(paths.rootPath, lock);
  }
}
