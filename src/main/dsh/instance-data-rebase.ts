import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from './disk';
import { atomicJson, contained, removeManaged, safeRelative } from './files';

const HEADER_LIMIT = 4 * 1024 ** 2;
const required = ['type', 'version', 'id', 'createdAt', 'delegationDepth'];
const optional = ['cwd', 'parentSession', 'origin', 'agentPreset'];
interface Header { type: 'session'; version: number; id: string; createdAt: number; cwd?: string; delegationDepth: number; [key: string]: unknown }
interface Rewrite { file: string; offset: number; headerBytes: Buffer; newHeader: Buffer; oldCwd: string; newCwd: string; version: number }
interface DirectoryMove { source: string; target: string }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const within = (root: string, value: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};
function mappedPath(value: string, oldRoot: string, newRoot: string): string {
  return path.isAbsolute(value) && within(oldRoot, value) ? path.join(newRoot, path.relative(oldRoot, value)) : value;
}

/** The published filesystem key is intentionally lossy and bounded, unlike the session id encoding. */
export function dshProjectKey(cwd: string): string {
  if (!cwd) throw new Error('Empty Session working directory.');
  let text = ''; let separator = false;
  for (let index = 0; index < cwd.length; index++) {
    const character = cwd[index]!;
    if ('/\\:'.includes(character)) { if (!separator) text += '-'; separator = true; }
    else { text += character !== '~' && /^[A-Za-z0-9._-]$/.test(character) ? character : `~${cwd.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`; separator = false; }
  }
  return `--${(text.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
function sessionSegment(id: string): string {
  if (!id) throw new Error('Empty Session id.');
  if (id === '.' || id === '..') return id.split('').map(() => '~002E').join('');
  let value = '';
  for (let index = 0; index < id.length; index++) {
    const character = id[index]!;
    value += character !== '~' && /^[A-Za-z0-9._-]$/.test(character) ? character : `~${id.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return value;
}

/** Locate only the first ordinary Zstandard frame; the remaining event frames are never decoded. */
export function firstSessionFrameEnd(buffer: Buffer): number {
  const requireBytes = (offset: number, count: number) => { if (offset + count > buffer.length) throw new Error('Truncated or oversized Session header frame.'); };
  requireBytes(0, 5);
  if (buffer.readUInt32LE(0) !== 0xFD2FB528) throw new Error('Unsupported Session compression framing.');
  const flags = buffer[4]!;
  if (flags & 0x18) throw new Error('Invalid Session Zstandard header flags.');
  const sizeFlag = flags >>> 6;
  const single = (flags & 0x20) !== 0;
  const dictionary = flags & 3;
  let offset = 5 + (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag);
  requireBytes(0, offset);
  for (;;) {
    requireBytes(offset, 3);
    const block = buffer.readUIntLE(offset, 3); offset += 3;
    const kind = (block >>> 1) & 3;
    if (kind === 3) throw new Error('Invalid Session Zstandard block.');
    const length = kind === 1 ? 1 : block >>> 3;
    requireBytes(offset, length); offset += length;
    if (block & 1) break;
  }
  if (flags & 4) { requireBytes(offset, 4); offset += 4; }
  return offset;
}

function parseHeader(bytes: Buffer, filenameVersion: number): Header {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Session header.');
  const header = value as Header;
  if (header.type !== 'session' || !Number.isSafeInteger(header.version) || header.version < 0 || header.version !== filenameVersion || typeof header.id !== 'string' || !header.id
    || typeof header.createdAt !== 'number' || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0
    || typeof header.delegationDepth !== 'number' || !Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0
    || (header.cwd !== undefined && (typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)))) throw new Error('Invalid or mismatched Session generation header.');
  if (header.version >= 0 && header.version <= 4) {
    const fields = new Set([...required, ...optional, header.version < 2 ? 'seedLength' : 'isSeeded']);
    if (required.some(key => !Object.hasOwn(header, key)) || Object.keys(header).some(key => !fields.has(key))) throw new Error('Unsupported Session header extension or retired policy fields.');
    if (header.version < 2) {
      if (header.seedLength !== undefined && (typeof header.seedLength !== 'number' || !Number.isSafeInteger(header.seedLength) || header.seedLength < 0)) throw new Error('Invalid historical Session seed length.');
    } else if (typeof header.isSeeded !== 'boolean') throw new Error('Invalid Session seed metadata.');
    if (header.origin !== undefined && header.origin !== 'subagent') throw new Error('Invalid Session origin.');
    if (['parentSession', 'agentPreset'].some(key => header[key] !== undefined && typeof header[key] !== 'string')) throw new Error('Invalid Session lineage metadata.');
  }
  return header;
}

async function inspectLog(file: string, filenameVersion: number, compressed: boolean): Promise<{ header: Header; offset: number; headerBytes: Buffer }> {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const prefix = Buffer.alloc(Math.min(size, HEADER_LIMIT));
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const raw = prefix.subarray(0, bytesRead);
    const offset = compressed ? firstSessionFrameEnd(raw) : raw.indexOf(10) + 1;
    if (offset <= 0) throw new Error('Truncated or oversized Session header line.');
    const headerBytes = compressed ? zstdDecompressSync(raw.subarray(0, offset), { maxOutputLength: HEADER_LIMIT }) : raw.subarray(0, offset);
    if (headerBytes.indexOf(10) !== headerBytes.length - 1) throw new Error('Session first frame must contain exactly one header line.');
    return { header: parseHeader(headerBytes, filenameVersion), offset, headerBytes: Buffer.from(raw.subarray(0, offset)) };
  } finally { await handle.close(); }
}

async function rewriteLog(rewrite: Rewrite, signal?: AbortSignal): Promise<void> {
  const temporary = `${rewrite.file}.${randomUUID()}.rebase`;
  try {
    const input = await open(rewrite.file, 'r');
    try {
      const output = await open(temporary, 'wx');
      try {
        const put = async (buffer: Buffer) => { let offset = 0; while (offset < buffer.length) { const written = (await output.write(buffer, offset, buffer.length - offset)).bytesWritten; if (!written) throw new Error('Session relocation could not finish writing.'); offset += written; } };
        await put(rewrite.newHeader);
        const buffer = Buffer.allocUnsafe(256 * 1024); let position = rewrite.offset;
        for (;;) {
          signal?.throwIfAborted(); const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          await put(buffer.subarray(0, bytesRead)); position += bytesRead;
        }
        await output.sync();
      } finally { await output.close(); }
    } finally { await input.close(); }
    signal?.throwIfAborted(); await rename(temporary, rewrite.file);
  } finally { await rm(temporary, { force: true }); }
}

/** Version-pinned offline relocation of operational metadata on an unpublished copy, never conversation events. */
export async function rebaseCopiedSessionData(options: { instanceRoot: string; oldRoot: string; runtimeVersion: string; signal?: AbortSignal }): Promise<void> {
  const { signal, runtimeVersion } = options;
  const instanceRoot = await realpath(options.instanceRoot);
  const oldRoot = path.resolve(options.oldRoot);
  const originalCanonical = await realpath(oldRoot).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return oldRoot; throw error; });
  if (within(originalCanonical, instanceRoot) || within(instanceRoot, originalCanonical)) throw new Error('Session migration requires a distinct, nonnested instance copy.');
  const sessions = path.join(instanceRoot, 'home', 'sessions');
  const rewrites: Rewrite[] = []; const moves = new Map<string, DirectoryMove>(); const targetOwners = new Map<string, string>();
  const directoryHeaders = new Map<string, { id: string; cwd?: string }>();
  let seen = 0;
  const walk = async (directory: string) => {
    const actual = await realpath(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (!actual) return;
    if (!within(instanceRoot, actual)) throw new Error('Session data points outside the unpublished instance copy.');
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; })) {
      signal?.throwIfAborted(); if (++seen > 150_000) throw new Error('Too many Session migration files.');
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Session migration refuses linked data.');
      if (entry.isDirectory()) { await walk(file); continue; }
      const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/.exec(entry.name);
      if (!match) continue;
      const version = match[1] === undefined ? 0 : Number(match[1]);
      const inspected = await inspectLog(file, version, !!match[2]);
      const { header } = inspected;
      const earlier = directoryHeaders.get(directory);
      if (earlier && (earlier.id !== header.id || earlier.cwd !== header.cwd)) throw new Error('Session generations disagree about their identity or working directory.');
      directoryHeaders.set(directory, { id: header.id, cwd: header.cwd });
      const nextCwd = header.cwd === undefined ? undefined : mappedPath(header.cwd, oldRoot, instanceRoot);
      if (nextCwd === header.cwd) continue;
      if (runtimeVersion !== '0.2.0-rc.2' || version > 4) throw new Error('This Session format/runtime has no verified working-directory relocation adapter.');
      const expected = path.join(sessions, header.cwd === undefined ? '_no-cwd' : dshProjectKey(header.cwd), sessionSegment(header.id));
      if (path.relative(expected, directory) !== '') throw new Error('Session header does not match its canonical source directory.');
      const target = path.join(sessions, dshProjectKey(nextCwd!), sessionSegment(header.id));
      safeRelative(path.relative(sessions, target));
      const key = target.toLowerCase(); const owner = targetOwners.get(key);
      if (owner && owner !== directory) throw new Error('Relocated Session directories collide.');
      targetOwners.set(key, directory);
      const previous = moves.get(directory);
      if (previous && previous.target !== target) throw new Error('Session generations disagree about their working directory.');
      moves.set(directory, { source: directory, target });
      const line = Buffer.from(`${JSON.stringify({ ...header, cwd: nextCwd })}\n`);
      const newHeader = match[2] ? zstdCompressSync(line, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }) : line;
      rewrites.push({ file, offset: inspected.offset, headerBytes: inspected.headerBytes, newHeader, oldCwd: header.cwd!, newCwd: nextCwd!, version });
    }
  };
  await walk(sessions);
  for (const move of moves.values()) if (move.source !== move.target && await lstat(move.target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; })) throw new Error('A relocated Session destination already exists.');

  const workspaceFile = path.join(instanceRoot, 'home', 'storages', 'workspace.json');
  let workspace: Record<string, unknown> | undefined; let workspaceChanged = false;
  try {
    if ((await lstat(workspaceFile)).isSymbolicLink()) throw new Error('Workspace migration refuses linked metadata.');
    if (!within(instanceRoot, await realpath(workspaceFile))) throw new Error('Workspace metadata points outside the unpublished instance copy.');
    if ((await lstat(workspaceFile)).size > 32 * 1024 ** 2) throw new Error('Workspace metadata is too large to relocate.');
    const value: unknown = JSON.parse(await readFile(workspaceFile, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace storage document.');
    workspace = value as Record<string, unknown>;
    const unit = workspace.unit as Record<string, unknown> | undefined;
    const tables = workspace.tables as Record<string, unknown> | undefined;
    const records = tables?.workspaces;
    if (unit?.name !== 'workspace' || unit.version !== 2 || !records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Unsupported workspace storage schema.');
    for (const record of Object.values(records)) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || typeof (record as Record<string, unknown>).path !== 'string') throw new Error('Invalid Workspace record.');
      const row = record as Record<string, unknown>; const current = row.path as string;
      if (!path.isAbsolute(current)) throw new Error('Workspace storage contains a nonabsolute project path.');
      const next = mappedPath(current, oldRoot, instanceRoot);
      if (next !== current) { if (runtimeVersion !== '0.2.0-rc.2') throw new Error('This runtime has no verified Workspace relocation adapter.'); row.path = next; workspaceChanged = true; }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  // Every header and destination is checked before changing any bytes in the new copy.
  for (const rewrite of rewrites) { signal?.throwIfAborted(); await rewriteLog(rewrite, signal); }
  for (const move of moves.values()) if (move.source !== move.target) { await mkdir(path.dirname(move.target), { recursive: true }); await rename(move.source, move.target); }
  if (workspaceChanged) await atomicJson(workspaceFile, workspace);
  if (rewrites.length || workspaceChanged) {
    for (const name of ['session_projcache', 'session_projcache.json']) await removeManaged(instanceRoot, contained(instanceRoot, `home/storages/${name}`));
    await atomicJson(path.join(instanceRoot, 'session-rebase-receipt.json'), { format: 'worldlinebox-session-rebase-v1', runtimeVersion, oldRoot,
      createdAt: new Date().toISOString(), workspaceChanged,
      headers: rewrites.map(rewrite => ({ file: path.relative(instanceRoot, path.join(moves.get(path.dirname(rewrite.file))!.target, path.basename(rewrite.file))),
        originalFile: path.relative(instanceRoot, rewrite.file), version: rewrite.version, oldCwd: rewrite.oldCwd, newCwd: rewrite.newCwd,
        originalHeaderSha256: digest(rewrite.headerBytes), relocatedHeaderSha256: digest(rewrite.newHeader) })) });
  }
}
