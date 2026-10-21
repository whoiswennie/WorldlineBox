import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, open, readdir, rm, stat, statfs } from 'node:fs/promises';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  embeddingSourceForModalities,
  clipEmbeddingDocument,
  formatEmbeddingDocument,
  normalizeEmbedding,
} from '../../shared/embedding/profile';
import type { EmbeddingSourceModality } from '../../shared/embedding/modalities';
import type { WorkerCommand, WorkerRequest } from '../../shared/protocol/requests';
import type { InternalLibrarySummary, WorkerResult } from '../../shared/protocol/responses';
import type { AssetSummary } from '../../shared/asset-types';
import type { LibraryService } from '../library-service';
import { backupExistingSemanticIndexFile, removeSemanticIndexForRebuild, SemanticIndexStore, type SemanticVectorProfile } from '../semantic-index-store';
import { digestLegacySemanticCache, parseLegacySemanticCache, type LegacySemanticCacheEntry } from '../legacy-semantic-cache';
import { resolveFfmpegPath, resolveFfprobePath } from '../binary-resolver';
import { prepareEmbeddingVideoWindows, type EmbeddingVideoWindow } from '../embedding-video';

const TARGET_PAGE_SIZE = 500;
const MAX_CANDIDATES = 100_000;
const MAX_TEXT_READ_BYTES = 256 * 1024;
const MAX_IMAGE_INPUT_BYTES = 64 * 1024 * 1024;
const AUDIO_WINDOW_SECONDS = 120;
const AUDIO_MAX_WINDOWS = 16;
const AUDIO_TEMP_PREFIX = 'worldlinebox-semantic-audio-';
const WORKER_PROCESS_MARKER = process.env.WORLDLINEBOX_MAIN_PROCESS_SESSION_ID ?? randomUUID();
const MAX_SEMANTIC_CLEANUP_IDS = 100_000;
const MAX_SEMANTIC_CLEANUP_QUEUE_FILES = 64;
const MAX_SEMANTIC_CLEANUP_QUEUE_BYTES = 4 * 1024 * 1024;

function semanticCleanupQueueDirectory(libraryPath: string): string {
  const libraryRoot = realpathSync(libraryPath);
  const worldlineboxPath = path.join(libraryRoot, '.worldlinebox');
  const worldlinebox = lstatSync(worldlineboxPath);
  if (!worldlinebox.isDirectory() || worldlinebox.isSymbolicLink()) throw new Error('Unsafe semantic cleanup directory.');
  const semanticPath = path.join(worldlineboxPath, 'semantic');
  try {
    const semantic = lstatSync(semanticPath);
    if (!semantic.isDirectory() || semantic.isSymbolicLink()) throw new Error('Unsafe semantic cleanup directory.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    mkdirSync(semanticPath);
  }
  return semanticPath;
}

function semanticCleanupQueuePaths(queueDirectory: string, repair = false): string[] {
  const names = readdirSync(queueDirectory);
  for (const name of names) {
    if (!/^permanent-delete-pending(?:-[a-f0-9-]{36})?\.json\.[a-f0-9-]{36}\.tmp$/u.test(name)) continue;
    const temporaryPath = path.join(queueDirectory, name);
    const info = lstatSync(temporaryPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe semantic cleanup temporary file.');
    unlinkSync(temporaryPath);
  }
  const queueNames = names.filter((name) =>
    name === 'permanent-delete-pending.json' || /^permanent-delete-pending-[a-f0-9-]{36}\.json$/u.test(name))
  if (queueNames.length > (repair ? 4096 : MAX_SEMANTIC_CLEANUP_QUEUE_FILES)) {
    throw new Error('Semantic cleanup queue has too many files.');
  }
  let aggregateBytes = 0;
  return queueNames.map((name) => {
    const queuePath = path.join(queueDirectory, name);
    const info = lstatSync(queuePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe semantic cleanup queue.');
    aggregateBytes += info.size;
    if (!repair && aggregateBytes > MAX_SEMANTIC_CLEANUP_QUEUE_BYTES) {
      throw new Error('Semantic cleanup queue exceeds its aggregate size limit.');
    }
    return queuePath;
  });
}

function readSemanticCleanupIds(queuePath: string, libraryId: string): string[] {
  try {
    const info = lstatSync(queuePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) {
      throw new Error('Semantic cleanup queue is invalid.');
    }
    const record = JSON.parse(readFileSync(queuePath, 'utf8')) as { version?: unknown; libraryId?: unknown; assetIds?: unknown };
    if (record.version !== 1 || record.libraryId !== libraryId || !Array.isArray(record.assetIds)
      || record.assetIds.length > MAX_SEMANTIC_CLEANUP_IDS
      || !record.assetIds.every((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,255}$/u.test(id))) {
      throw new Error('Semantic cleanup queue contents are invalid.');
    }
    return [...new Set(record.assetIds as string[])];
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function writeSemanticCleanupIds(queuePath: string, libraryId: string, assetIds: readonly string[]): void {
  const unique = [...new Set(assetIds)];
  if (unique.length === 0 || unique.length > MAX_SEMANTIC_CLEANUP_IDS) {
    throw new Error('Semantic cleanup queue exceeds its item limit.');
  }
  const temporaryPath = `${queuePath}.${randomUUID()}.tmp`;
  try {
    const serialized = JSON.stringify({ version: 1, libraryId, assetIds: unique });
    if (Buffer.byteLength(serialized) > MAX_SEMANTIC_CLEANUP_QUEUE_BYTES) {
      throw new Error('Semantic cleanup queue exceeds its aggregate size limit.');
    }
    writeFileSync(temporaryPath, serialized, { flag: 'wx' });
    renameSync(temporaryPath, queuePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function clearSemanticCleanupQueue(queuePath: string): void {
  try {
    unlinkSync(queuePath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export function reserveSemanticDeleteCleanup(service: LibraryService, libraryId: string,
  candidateAssetIds: readonly string[]): void {
  const candidates = [...new Set(candidateAssetIds)];
  if (candidates.length === 0) {
    throw new Error('Semantic delete cleanup reservation exceeds its item limit.');
  }
  const library = currentLibrary(service, libraryId);
  const queueDirectory = semanticCleanupQueueDirectory(library.libraryPath);
  const queuePaths = semanticCleanupQueuePaths(queueDirectory);
  if (queuePaths.length > 0) {
    const databasePath = path.join(library.libraryPath, '.worldlinebox', 'semantic', 'index.sqlite');
    let store = sessions.get(libraryId)?.store;
    let owned = false;
    if (!store) {
      try {
        const info = lstatSync(databasePath);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Semantic index path is not a regular file.');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (existsSync(databasePath)) {
        store = new SemanticIndexStore({ libraryPath: library.libraryPath, libraryId,
          storageKind: library.storageKind ?? 'unknown' });
        owned = true;
      }
    }
    try {
      for (const queuePath of queuePaths) {
        const pending = readSemanticCleanupIds(queuePath, libraryId);
        if (store) {
          const live = new Set(service.getSemanticAssetSources(libraryId, pending).map((asset) => asset.assetId));
          for (const assetId of pending) if (!live.has(assetId)) store.removeAsset(assetId);
        }
        clearSemanticCleanupQueue(queuePath);
      }
    } finally {
      if (owned) store?.close();
    }
  }
  const remainingQueueFiles = semanticCleanupQueuePaths(queueDirectory).length;
  const batches = Math.ceil(candidates.length / MAX_SEMANTIC_CLEANUP_IDS);
  if (remainingQueueFiles + batches > MAX_SEMANTIC_CLEANUP_QUEUE_FILES) {
    throw new Error('Semantic delete cleanup reservation exceeds the queue capacity.');
  }
  for (let offset = 0; offset < candidates.length; offset += MAX_SEMANTIC_CLEANUP_IDS) {
    const queuePath = path.join(queueDirectory, `permanent-delete-pending-${randomUUID()}.json`);
    writeSemanticCleanupIds(queuePath, libraryId,
      candidates.slice(offset, offset + MAX_SEMANTIC_CLEANUP_IDS));
  }
}

export function semanticPermanentDeleteCandidates(service: LibraryService, command: WorkerCommand): string[] {
  if (command.type === 'asset.delete-permanent' || command.type === 'asset.delete-from-disk'
    || command.type === 'asset.delete-linked') return [...command.assetIds];
  if (command.type !== 'asset.purge-trash') return [];
  const ids: string[] = [];
  const snapshot = service.getBrowseChangeSequence(command.libraryId);
  for (let offset = 0; offset < Number.MAX_SAFE_INTEGER; offset += TARGET_PAGE_SIZE) {
    const page = service.searchAssets({ libraryId: command.libraryId, query: null, filters: [],
      scope: { kind: 'trash' }, showIgnored: true, idsOnly: true, idsPage: true,
      limit: TARGET_PAGE_SIZE, offset });
    if (service.getBrowseChangeSequence(command.libraryId) !== snapshot) {
      throw new Error('Trash changed while reserving semantic index cleanup.');
    }
    const pageIds = page.assetIds ?? [];
    if (pageIds.length === 0) {
      if (offset < page.total) throw new Error('Could not enumerate the complete trash for semantic cleanup.');
      break;
    }
    ids.push(...pageIds);
    if (ids.length >= page.total) break;
  }
  return ids;
}

function clearSemanticCleanupQueuesForRebuild(libraryPath: string): void {
  const queueDirectory = semanticCleanupQueueDirectory(libraryPath);
  for (const queuePath of semanticCleanupQueuePaths(queueDirectory, true)) clearSemanticCleanupQueue(queuePath);
}

type Session = {
  generation: string;
  profile: SemanticVectorProfile;
  profileId: string;
  store: SemanticIndexStore;
  modalities: readonly EmbeddingSourceModality[];
};

const sessions = new Map<string, Session>();
const cancelledSearches = new Map<string, Set<string>>();
const audioHandles = new Map<string, { libraryId: string; generation: string; windows: Buffer[] }>();
const activeAudioJobs = new Map<string, { controller: AbortController; promise: Promise<Buffer[]> }>();
const activeVideoJobs = new Map<string, { controller: AbortController; promise: Promise<EmbeddingVideoWindow[]> }>();

export async function backupSemanticIndexWorkerLibrary(input: {
  libraryId: string;
  libraryPath: string;
  storageKind: 'local' | 'network' | 'unknown';
  destinationPath: string;
}): Promise<boolean> {
  const active = sessions.get(input.libraryId);
  if (active) {
    await active.store.backupTo(input.destinationPath);
    return true;
  }
  const sourcePath = path.join(input.libraryPath, '.worldlinebox', 'semantic', 'index.sqlite');
  try {
    const file = lstatSync(sourcePath);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('Semantic index source is not a regular library file.');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
  await backupExistingSemanticIndexFile({ libraryPath: input.libraryPath,
    libraryId: input.libraryId, destinationPath: input.destinationPath });
  return true;
}

/** Remove sidecar rows only after the catalog confirms a permanent deletion. */
export function reconcileSemanticPermanentDeletes(
  service: LibraryService,
  libraryId: string,
  candidateAssetIds: readonly string[],
): void {
  const unique = [...new Set(candidateAssetIds)];
  if (unique.length === 0) return;
  const library = currentLibrary(service, libraryId);
  const live = new Set(service.getSemanticAssetSources(libraryId, unique).map((asset) => asset.assetId));
  const deleted = unique.filter((assetId) => !live.has(assetId));
  const queueDirectory = semanticCleanupQueueDirectory(library.libraryPath);
  let queuePaths = semanticCleanupQueuePaths(queueDirectory);
  if (queuePaths.length === 0 && deleted.length > 0) {
    const queuePath = path.join(queueDirectory, 'permanent-delete-pending.json');
    writeSemanticCleanupIds(queuePath, libraryId, deleted);
    queuePaths = [queuePath];
  }
  const active = sessions.get(libraryId);
  let store = active?.store;
  let owned = false;
  if (!store && deleted.length > 0) {
    const databasePath = path.join(library.libraryPath, '.worldlinebox', 'semantic', 'index.sqlite');
    try {
      const info = lstatSync(databasePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Semantic index path is not a regular file.');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        for (const queuePath of queuePaths) clearSemanticCleanupQueue(queuePath);
        return;
      }
      throw error;
    }
    store = new SemanticIndexStore({ libraryPath: library.libraryPath, libraryId,
      storageKind: library.storageKind ?? 'unknown' });
    owned = true;
  }
  try {
    for (const queuePath of queuePaths) {
      if (store) {
        const queued = readSemanticCleanupIds(queuePath, libraryId);
        for (const assetId of queued) if (!live.has(assetId)) store.removeAsset(assetId);
      }
      clearSemanticCleanupQueue(queuePath);
    }
  } finally {
    if (owned) store?.close();
  }
}

export function withSemanticDeleteCleanupStatus(
  service: LibraryService,
  libraryId: string,
  candidateAssetIds: readonly string[],
  result: WorkerResult,
): WorkerResult {
  if (candidateAssetIds.length === 0 || !result.ok) return result;
  try {
    reconcileSemanticPermanentDeletes(service, libraryId, candidateAssetIds);
    return result;
  } catch (error) {
    service.reportDiagnostic('semantic-index.permanent-delete-reconcile', error, { libraryId });
    if (result.type === 'asset.deleted-permanent' || result.type === 'asset.deleted-from-disk'
      || result.type === 'asset.deleted-linked' || result.type === 'asset.purge-trash') {
      return { ...result, semanticCleanupPending: true };
    }
    return result;
  }
}

function retrySemanticPermanentDeletes(service: LibraryService, libraryId: string, libraryPath: string,
  store: SemanticIndexStore): void {
  const queueDirectory = semanticCleanupQueueDirectory(libraryPath);
  for (const queuePath of semanticCleanupQueuePaths(queueDirectory)) {
    const pending = readSemanticCleanupIds(queuePath, libraryId);
    const live = new Set(service.getSemanticAssetSources(libraryId, pending).map((asset) => asset.assetId));
    for (const assetId of pending) {
      if (!live.has(assetId)) store.removeAsset(assetId);
    }
    clearSemanticCleanupQueue(queuePath);
  }
}

async function readFileBounded(filePath: string, maxBytes: number, allowTruncate = false): Promise<Buffer> {
  const file = await open(filePath, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || (!allowTruncate && info.size > maxBytes)) {
      throw new Error('Semantic media input exceeds the supported size.');
    }
    const bytes = Buffer.allocUnsafe(allowTruncate ? maxBytes : maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error('Semantic media input exceeds the supported size.');
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function isSemanticCommand(command: WorkerCommand): command is Extract<WorkerCommand, {
  type: 'semantic.index.begin' | 'semantic.index.targets' | 'semantic.index.prepare'
    | 'semantic.index.audio.release' | 'semantic.index.audio-window' | 'semantic.index.write'
    | 'semantic.index.search' | 'semantic.index.cancel-search' | 'semantic.index.similar'
    | 'semantic.index.close' | 'semantic.index.job' | 'semantic.index.import-legacy' | 'semantic.index.rebuild';
}> {
  return command.type.startsWith('semantic.index.');
}

async function convertAudio(sourcePath: string, signal: AbortSignal): Promise<Buffer[]> {
  const free = await statfs(tmpdir());
  if (free.bavail * free.bsize < 80 * 1024 * 1024) throw new Error('Not enough temporary disk space for audio analysis.');
  const directory = await mkdtemp(path.join(tmpdir(), AUDIO_TEMP_PREFIX));
  try {
    const outputPattern = path.join(directory, 'window-%03d.wav');
    const child = spawn(resolveFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', sourcePath,
      '-t', String(AUDIO_WINDOW_SECONDS * AUDIO_MAX_WINDOWS), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', String(AUDIO_WINDOW_SECONDS),
      '-reset_timestamps', '1', outputPattern,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise<void>((resolve, reject) => {
      const abort = () => child.kill();
      const timer = setTimeout(() => child.kill(), 120_000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) child.kill();
      child.once('error', (error) => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (signal.aborted) { reject(new Error('Audio preparation was cancelled.')); return; }
        if (code === 0) resolve();
        else reject(new Error('Audio conversion failed.'));
      });
    });
    const files = (await readdir(directory)).filter((name) => /^window-\d+\.wav$/u.test(name)).sort().slice(0, AUDIO_MAX_WINDOWS);
    const windows: Buffer[] = [];
    for (const file of files) {
      const wav = await readFileBounded(path.join(directory, file), 8 * 1024 * 1024);
      windows.push(wav);
    }
    if (windows.length === 0) throw new Error('Audio produced no samples.');
    return windows;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function currentLibrary(service: LibraryService, libraryId: string): InternalLibrarySummary {
  const library = service.listLibraries().find((entry) => entry.libraryId === libraryId);
  if (!library) throw new Error('Semantic index library is not open.');
  return library;
}

function currentSession(libraryId: string, generation: string): Session {
  const session = sessions.get(libraryId);
  if (!session || session.generation !== generation) throw new Error('Semantic index session is stale.');
  return session;
}

function clearCancelledQuery(libraryId: string, queryId: string): void {
  const cancelled = cancelledSearches.get(libraryId);
  cancelled?.delete(queryId);
  if (cancelled?.size === 0) cancelledSearches.delete(libraryId);
}

function sourceForAsset(asset: {
  mediaType: AssetSummary['mediaType'];
  relativeFilePath: string;
  sequence?: unknown;
  currentRevisionId: string;
  availability?: AssetSummary['availability'];
  thumbnailArtifactId?: string | null;
  thumbnailStatus?: string | null;
  deletedAt?: string | null;
  displayName: string;
}, modalities: readonly EmbeddingSourceModality[] = ['audio', 'text', 'image', 'video']): {
  kind: 'image' | 'video' | 'audio' | 'text';
  revision: string;
} | null {
  return embeddingSourceForModalities(asset, modalities);
}

function legacyCacheFile(cacheKind: 'local' | 'http', libraryId: string, cacheId: string): string | null {
  const root = process.env.WORLDLINEBOX_SEMANTIC_LEGACY_CACHE_ROOT;
  if (!root || !/^[a-zA-Z0-9_-]{1,255}$/u.test(libraryId) || !/^[a-zA-Z0-9._-]{1,255}$/u.test(cacheId)) return null;
  const resolvedRoot = realpathSync(root);
  const directory = path.join(resolvedRoot, cacheKind === 'local' ? 'embedding-test-index' : 'embedding-http-index');
  const libraryDirectory = path.join(directory, libraryId);
  for (const candidate of [directory, libraryDirectory]) {
    try {
      const info = lstatSync(candidate);
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  const filePath = path.join(libraryDirectory, `${cacheId}.json`);
  try {
    const info = lstatSync(filePath);
    return info.isFile() && !info.isSymbolicLink() ? filePath : null;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function sameLegacyFileSnapshot(pathname: string, initial: Stats): boolean {
  const current = lstatSync(pathname);
  return current.isFile() && !current.isSymbolicLink()
    && current.dev === initial.dev && current.ino === initial.ino
    && current.size === initial.size && current.mtimeMs === initial.mtimeMs;
}

async function verifyLegacyImport(
  service: LibraryService,
  session: Session,
  libraryId: string,
  filePath: string,
  acceptedRowsExpected: number,
): Promise<boolean> {
  let headerValid = false;
  let matchedRows = 0;
  let batch: LegacySemanticCacheEntry[] = [];
  const flush = async (): Promise<void> => {
    const rows = batch;
    batch = [];
    const assets = service.getSemanticAssetSources(libraryId, rows.map((row) => row.assetId));
    const current = new Map(assets.map((asset) => [asset.assetId, sourceForAsset(asset, session.modalities)] as const));
    for (const row of rows) {
      const source = current.get(row.assetId);
      if (!source || source.kind === 'text' || source.revision !== row.revisionId
        || row.vector.length !== session.profile.dimensions) continue;
      const stored = session.store.vectorFor(session.profileId, row.assetId, source.revision);
      if (!stored) continue;
      try {
        const normalized = normalizeEmbedding(row.vector);
        if (normalized.length === stored.length
          && normalized.every((value, index) => Math.abs(value - (stored[index] ?? 0)) <= 1e-5)) matchedRows += 1;
      } catch {
        // Invalid old vectors are omitted from the verified row count.
      }
    }
  };
  try {
    await parseLegacySemanticCache(filePath, (header) => {
      headerValid = header.version === 1 && header.profileKey === session.profile.profileKey;
    }, async (entry) => {
      if (!headerValid || !entry) return;
      batch.push(entry);
      if (batch.length >= 128) await flush();
    });
    await flush();
    return headerValid && matchedRows === acceptedRowsExpected;
  } catch {
    return false;
  }
}

async function importLegacyCache(
  service: LibraryService,
  session: Session,
  libraryId: string,
  cacheKind: 'local' | 'http',
  cacheId: string,
): Promise<{ attempted: boolean; acceptedRows: number; rejectedRows: number }> {
  const filePath = legacyCacheFile(cacheKind, libraryId, cacheId);
  if (!filePath) return { attempted: false, acceptedRows: 0, rejectedRows: 0 };
  let initialFileStat: Stats;
  try {
    initialFileStat = lstatSync(filePath);
  } catch {
    return { attempted: false, acceptedRows: 0, rejectedRows: 0 };
  }
  if (!initialFileStat.isFile() || initialFileStat.isSymbolicLink()) return { attempted: false, acceptedRows: 0, rejectedRows: 0 };
  let digest: string;
  try {
    const free = await statfs(currentLibrary(service, libraryId).libraryPath);
    const freeBytes = Number(free.bavail) * Number(free.bsize);
    const requiredBytes = Math.max(64 * 1024 * 1024, initialFileStat.size * 3 + 16 * 1024 * 1024);
    if (!Number.isFinite(requiredBytes) || freeBytes < requiredBytes) {
      return { attempted: false, acceptedRows: 0, rejectedRows: 0 };
    }
    ({ digest } = await digestLegacySemanticCache(filePath));
  } catch {
    return { attempted: false, acceptedRows: 0, rejectedRows: 0 };
  }
  const priorImport = session.store.legacyImportFor(digest, session.profileId);
  if (priorImport) {
    if (priorImport.processMarker && priorImport.processMarker !== WORKER_PROCESS_MARKER) {
      try {
        const verified = await verifyLegacyImport(service, session, libraryId, filePath, priorImport.acceptedRows);
        const afterDigest = await digestLegacySemanticCache(filePath);
        if (verified && afterDigest.digest === digest && sameLegacyFileSnapshot(filePath, initialFileStat)) {
          unlinkSync(filePath);
        }
      } catch {
        // Keep the source cache if restart verification or cleanup is inconclusive.
      }
    }
    return { attempted: true, acceptedRows: 0, rejectedRows: 0 };
  }
  let headerValid = false;
  let acceptedRows = 0;
  let rejectedRows = 0;
  const newlyWritten: Array<{ assetId: string; sourceRevision: string }> = [];
  let batch: LegacySemanticCacheEntry[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0 || !headerValid) return;
    const rows = batch;
    batch = [];
    const assets = service.getSemanticAssetSources(libraryId, rows.map((row) => row.assetId));
    const current = new Map(assets.map((asset) => [asset.assetId, sourceForAsset(asset, session.modalities)] as const));
    const candidates = rows.flatMap((row) => {
      const source = current.get(row.assetId);
      // Older text revisions omitted the file title. There is no trustworthy
      // evidence that those vectors match the current model input.
      if (!source || source.kind === 'text' || source.revision !== row.revisionId
        || row.vector.length !== session.profile.dimensions) {
        rejectedRows += 1;
        return [];
      }
      return [{ assetId: row.assetId, sourceRevision: source.revision, vector: row.vector }];
    });
    if (candidates.length === 0) return;
    // A matching current vector is already valid migration output. Avoid
    // overwriting it until the entire legacy file has passed validation; a
    // later malformed tail must not leave partial cache data in the index.
    const writeCandidates = candidates.filter((candidate) =>
      !session.store.hasVector(session.profileId, candidate.assetId, candidate.sourceRevision));
    if (writeCandidates.length === 0) return;
    session.store.markPendingBatch(session.profileId,
      writeCandidates.map(({ assetId, sourceRevision }) => ({ assetId, sourceRevision })));
    const result = session.store.upsertBatch(session.profileId, writeCandidates);
    acceptedRows += result.accepted.length;
    rejectedRows += result.rejected.length;
    for (const row of writeCandidates) {
      if (result.accepted.includes(row.assetId)) {
        newlyWritten.push({ assetId: row.assetId, sourceRevision: row.sourceRevision });
      }
    }
  };
  try {
    await parseLegacySemanticCache(filePath, (header) => {
      headerValid = header.version === 1 && header.profileKey === session.profile.profileKey;
    }, async (entry) => {
      if (!headerValid) return;
      if (!entry) {
        rejectedRows += 1;
        return;
      }
      batch.push(entry);
      if (batch.length >= 128) await flush();
    });
    await flush();
    if (!headerValid) return { attempted: false, acceptedRows: 0, rejectedRows: 0 };
    const afterDigest = await digestLegacySemanticCache(filePath);
    if (afterDigest.digest !== digest || !sameLegacyFileSnapshot(filePath, initialFileStat)) {
      for (const row of newlyWritten) session.store.removeVector(session.profileId, row.assetId, row.sourceRevision);
      return { attempted: false, acceptedRows: 0, rejectedRows: 0 };
    }
    session.store.recordLegacyImport({ contentDigest: digest, profileId: session.profileId,
      acceptedRows, rejectedRows, processMarker: WORKER_PROCESS_MARKER });
    return { attempted: true, acceptedRows, rejectedRows };
  } catch {
    // An obsolete or corrupt cache must never block the live provider from
    // rebuilding current vectors. Keep the source file for diagnosis/retry.
    for (const row of newlyWritten) session.store.removeVector(session.profileId, row.assetId, row.sourceRevision);
    return { attempted: false, acceptedRows: 0, rejectedRows: 0 };
  }
}

/** Worker-only dispatch. Asset paths and SQLite handles never leave this module. */
export async function executeSemanticIndexWorkerCommand(
  service: LibraryService,
  request: WorkerRequest,
  hooks: {
    runWithoutAdmission: <T>(work: () => Promise<T>) => Promise<T>;
    onTiming?: (phase: string, durationMs: number) => void;
  },
): Promise<WorkerResult | undefined> {
  const command = request.command;
  if (command.type === 'semantic.index.begin') {
    const library = currentLibrary(service, command.libraryId);
    const previous = sessions.get(command.libraryId);
    const profileKey = command.profileKey;
    const modalities = command.modalities ?? ['image', 'audio', 'text'];
    if (previous?.generation === command.sessionGeneration
      && previous.profile.profileKey === profileKey
      && previous.profile.dimensions === command.dimensions
      && previous.profile.modelRevision === command.modelRevision
      && previous.profile.modality === command.modality
      && previous.modalities.join(',') === modalities.join(',')) {
      return { ok: true, type: 'semantic.index.started', profileId: previous.profileId,
        nativeCosineAvailable: previous.store.nativeCosineAvailable };
    }
    if (previous) await closeSemanticIndexWorkerLibrary(command.libraryId);
    const store = new SemanticIndexStore({
      libraryPath: library.libraryPath,
      libraryId: library.libraryId,
      storageKind: library.storageKind ?? 'unknown',
    });
    const profile: SemanticVectorProfile = {
      profileKey: command.profileKey,
      dimensions: command.dimensions,
      modelRevision: command.modelRevision,
      modality: command.modality,
    };
    let profileId: string;
    try {
      profileId = store.ensureProfile(profile);
      const vectorSources = store.vectorSources(profileId);
      if (vectorSources.length <= MAX_CANDIDATES) {
        const liveRevisions = new Map<string, string>();
        for (let start = 0; start < vectorSources.length; start += TARGET_PAGE_SIZE) {
          const sources = vectorSources.slice(start, start + TARGET_PAGE_SIZE);
          const assets = service.getSemanticAssetSources(command.libraryId, sources.map(({ assetId }) => assetId));
          for (const asset of assets) {
            const source = sourceForAsset(asset, modalities);
            if (source) liveRevisions.set(asset.assetId, source.revision);
          }
          await hooks.runWithoutAdmission(() => new Promise<void>((resolve) => setImmediate(resolve)));
          if (service.listLibraries().find((entry) => entry.libraryId === command.libraryId)?.libraryPath !== library.libraryPath) {
            throw new Error('Semantic library changed during stale index reconciliation.');
          }
        }
      store.removeStale(profileId, liveRevisions);
    }
      retrySemanticPermanentDeletes(service, command.libraryId, library.libraryPath, store);
    } catch (error) {
      store.close();
      throw error;
    }
    sessions.set(command.libraryId, { generation: command.sessionGeneration, profile, profileId, store, modalities });
    return {
      ok: true,
      type: 'semantic.index.started',
      profileId,
      nativeCosineAvailable: store.nativeCosineAvailable,
    };
  }

  if (!isSemanticCommand(command)) return undefined;
  if (command.type === 'semantic.index.rebuild') {
    if (command.confirmed !== true) throw new Error('Semantic index rebuild was not confirmed.');
    const library = currentLibrary(service, command.libraryId);
    await closeSemanticIndexWorkerLibrary(command.libraryId);
    removeSemanticIndexForRebuild(library.libraryPath, library.libraryId);
    clearSemanticCleanupQueuesForRebuild(library.libraryPath);
    return { ok: true, type: 'semantic.index.rebuilt' };
  }
  if (command.type === 'semantic.index.close') {
    const session = sessions.get(command.libraryId);
    if (session?.generation === command.sessionGeneration) {
      await closeSemanticIndexWorkerLibrary(command.libraryId);
    }
    return { ok: true, type: 'semantic.index.closed' };
  }
  if (command.type === 'semantic.index.cancel-search') {
    let cancelled = cancelledSearches.get(command.libraryId);
    if (!cancelled) cancelledSearches.set(command.libraryId, cancelled = new Set());
    cancelled.add(command.queryId);
    while (cancelled.size > 128) {
      const oldest = cancelled.values().next().value as string | undefined;
      if (oldest === undefined) break;
      cancelled.delete(oldest);
    }
    return { ok: true, type: 'semantic.index.cancelled' };
  }

  const session = currentSession(command.libraryId, command.sessionGeneration);
  if (command.type === 'semantic.index.import-legacy') {
    const imported = await importLegacyCache(service, session, command.libraryId, command.cacheKind, command.cacheId);
    return { ok: true, type: 'semantic.index.legacy-imported', ...imported };
  }
  if (command.type === 'semantic.index.targets') {
    const before = service.getBrowseChangeSequence(command.libraryId);
    if (command.revisionSnapshot !== undefined && command.revisionSnapshot !== null
      && command.revisionSnapshot !== before) {
      return { ok: true, type: 'semantic.index.targets', revisionSnapshot: before,
        snapshotChanged: true, total: 0, nextOffset: null, targets: [] };
    }
    const page = command.assetId ? null : service.searchAssets({
      libraryId: command.libraryId,
      query: null,
      filters: [],
      limit: command.limit,
      offset: command.offset,
      idsOnly: true,
      idsPage: true,
      showIgnored: false,
    });
    const pageIds = command.assetId ? [command.assetId] : page?.assetIds ?? [];
    const assets = pageIds.length
      ? service.getSemanticAssetSources(command.libraryId, pageIds)
      : [];
    const allowedModalities = command.modalities
      .filter((modality): modality is EmbeddingSourceModality => session.modalities.includes(modality));
    const kindById = new Map(assets.flatMap((asset) => {
      const source = sourceForAsset(asset, allowedModalities);
      return source
        ? [[asset.assetId, { ...source, modality: source.kind, alreadyIndexed: session.store.hasVector(session.profileId, asset.assetId, source.revision) }] as const]
        : [];
    }));
    const targets = pageIds.flatMap((assetId) => {
      const source = kindById.get(assetId);
      if (!source) return [];
      return [{ assetId, sourceRevision: source.revision, kind: source.kind,
        modality: source.modality, alreadyIndexed: source.alreadyIndexed }];
    }) ?? [];
    session.store.markPendingBatch(session.profileId, targets
      .filter((target) => !target.alreadyIndexed)
      .map(({ assetId, sourceRevision }) => ({ assetId, sourceRevision })));
    const targetsWithJobs = targets.map((target) => ({
      ...target,
      jobStatus: session.store.jobFor(session.profileId, target.assetId)?.status,
    }));
    const after = service.getBrowseChangeSequence(command.libraryId);
    if (before !== after) return { ok: true, type: 'semantic.index.targets',
      revisionSnapshot: after, snapshotChanged: true, total: 0, nextOffset: null, targets: [] };
    return {
      ok: true,
      type: 'semantic.index.targets',
      revisionSnapshot: before,
      total: command.assetId ? targetsWithJobs.length : page?.total ?? 0,
      nextOffset: command.assetId ? null : command.offset + command.limit < (page?.total ?? 0) ? command.offset + command.limit : null,
      targets: targetsWithJobs,
    };
  }

  if (command.type === 'semantic.index.job') {
    if (command.action === 'claim') {
      const [asset] = service.getSemanticAssetSources(command.libraryId, [command.assetId]);
      const source = asset ? sourceForAsset(asset, session.modalities) : null;
      if (source?.revision !== command.sourceRevision) {
        return { ok: true, type: 'semantic.index.job-updated', updated: false };
      }
      if (!session.store.hasVector(session.profileId, command.assetId, command.sourceRevision)) {
        session.store.markPending(session.profileId, command.assetId, command.sourceRevision);
      }
      return { ok: true, type: 'semantic.index.job-updated',
        updated: session.store.markRunning(session.profileId, command.assetId, command.sourceRevision, command.claimToken) };
    }
    const before = session.store.jobFor(session.profileId, command.assetId);
    session.store.markFailed(session.profileId, command.assetId, command.sourceRevision,
      command.claimToken, command.errorCategory ?? 'provider');
    const after = session.store.jobFor(session.profileId, command.assetId);
    return { ok: true, type: 'semantic.index.job-updated', updated: before?.status === 'running'
      && after?.status === 'failed' && after.sourceRevision === command.sourceRevision };
  }

  if (command.type === 'semantic.index.write') {
    if (command.profileKey !== session.profile.profileKey) throw new Error('Semantic profile changed.');
    const ids = command.vectors.map(({ assetId }) => assetId);
    const assets = service.getSemanticAssetSources(command.libraryId, ids);
    const current = new Map(assets.map((asset) => [asset.assetId, sourceForAsset(asset, session.modalities)] as const));
    const staleRevisionIds = command.vectors
      .filter((item) => current.get(item.assetId)?.revision !== item.sourceRevision)
      .map(({ assetId }) => assetId);
    const currentRevisionInputs = command.vectors
      .filter((item) => current.get(item.assetId)?.revision === item.sourceRevision);
    // Let the store perform claim fencing inside the same transaction as the
    // vector write. Pre-filtering by claim state here can report neither
    // accepted nor rejected for a stale claim, which makes provider progress
    // count the item inconsistently.
    const result = session.store.upsertBatch(session.profileId, currentRevisionInputs);
    const accepted = result.accepted;
    const acceptedSet = new Set(accepted);
    const rejected = [...new Set([...result.rejected, ...staleRevisionIds])]
      .filter((assetId) => !acceptedSet.has(assetId));
    return {
      ok: true,
      type: 'semantic.index.written',
      accepted,
      rejected,
    };
  }

  if (command.type === 'semantic.index.prepare') {
    const [asset] = service.listAssets({
      libraryId: command.libraryId,
      recursive: true,
      assetIds: [command.assetId],
    });
    if (!asset) throw new Error('Semantic asset was removed.');
    const source = sourceForAsset(asset, [command.kind]);
    if (!source || source.kind !== command.kind || source.revision !== command.sourceRevision) {
      throw new Error('Semantic asset revision changed.');
    }
    if (command.kind === 'text') {
      const sourcePath = service.resolveAssetPath(command.libraryId, command.assetId);
      const bytes = await hooks.runWithoutAdmission(async () => {
        const sourceStat = await stat(sourcePath);
        if (sourceStat.size <= 0) throw new Error('Semantic text asset is empty.');
        return readFileBounded(sourcePath, Math.min(command.maxInputBytes, MAX_TEXT_READ_BYTES), true);
      });
      currentSession(command.libraryId, command.sessionGeneration);
      const [currentAsset] = service.getSemanticAssetSources(command.libraryId, [command.assetId]);
      const currentSource = currentAsset && sourceForAsset(currentAsset, [command.kind]);
      if (!currentSource || currentSource.revision !== command.sourceRevision) {
        throw new Error('Semantic asset revision changed during text preparation.');
      }
      const content = clipEmbeddingDocument(bytes.toString('utf8'));
      if (!content) throw new Error('Semantic text asset has no readable text.');
      const text = formatEmbeddingDocument(currentAsset.displayName, content);
      return { ok: true, type: 'semantic.index.prepared', assetId: currentAsset.assetId,
        sourceRevision: currentSource.revision, kind: 'text', text };
    }
    if (command.kind === 'video') {
      const sourcePath = service.resolveAssetPath(command.libraryId, command.assetId);
      const jobKey = `${command.libraryId}:${command.sessionGeneration}:${command.assetId}`;
      const controller = new AbortController();
      const job = { controller, promise: prepareEmbeddingVideoWindows({ sourcePath, ffmpegPath: resolveFfmpegPath(), ffprobePath: resolveFfprobePath(), signal: controller.signal }) };
      activeVideoJobs.set(jobKey, job);
      let videoWindows: EmbeddingVideoWindow[];
      try { videoWindows = await hooks.runWithoutAdmission(() => job.promise); }
      finally { if (activeVideoJobs.get(jobKey) === job) activeVideoJobs.delete(jobKey); }
      currentSession(command.libraryId, command.sessionGeneration);
      const [currentAsset] = service.getSemanticAssetSources(command.libraryId, [command.assetId]);
      const currentSource = currentAsset && sourceForAsset(currentAsset, [command.kind]);
      if (!currentSource || currentSource.revision !== command.sourceRevision) {
        throw new Error('Semantic video revision changed during preparation.');
      }
      return {
        ok: true,
        type: 'semantic.index.prepared',
        assetId: currentAsset.assetId,
        sourceRevision: currentSource.revision,
        kind: 'video',
        videoWindows,
      };
    }
    if (command.kind === 'image') {
      let sourcePath: string | null;
      if (asset.mediaType === 'image' && source.revision === asset.currentRevisionId) {
        sourcePath = service.resolveAssetPath(command.libraryId, command.assetId);
      } else {
        const artifact = service.getThumbnailArtifact(command.libraryId, command.assetId);
        sourcePath = artifact
          ? service.getArtifactAbsolutePath(command.libraryId, artifact.artifactId, 'preview')
          : null;
      }
      if (!sourcePath) throw new Error('Semantic image preview is unavailable.');
      const bytes = await hooks.runWithoutAdmission(async () => {
        const sourceStat = await stat(sourcePath);
        if (sourceStat.size <= 0 || sourceStat.size > Math.min(command.maxInputBytes, MAX_IMAGE_INPUT_BYTES)) {
          throw new Error('Semantic image exceeds the supported input size.');
        }
        return readFileBounded(sourcePath, Math.min(command.maxInputBytes, MAX_IMAGE_INPUT_BYTES));
      });
      currentSession(command.libraryId, command.sessionGeneration);
      const [currentAsset] = service.getSemanticAssetSources(command.libraryId, [command.assetId]);
      const currentSource = currentAsset && sourceForAsset(currentAsset, [command.kind]);
      if (!currentSource || currentSource.revision !== command.sourceRevision) {
        throw new Error('Semantic asset revision changed during image preparation.');
      }
      const extension = path.extname(sourcePath).toLowerCase();
      const mimeType = extension === '.png' ? 'image/png'
        : extension === '.webp' ? 'image/webp'
          : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
      return {
        ok: true,
        type: 'semantic.index.prepared',
        assetId: currentAsset.assetId,
        sourceRevision: currentSource.revision,
        kind: 'image',
        mimeType,
        bytesBase64: bytes.toString('base64'),
      };
    }
    const sourcePath = service.resolveAssetPath(command.libraryId, command.assetId);
    const audioJob = { controller: new AbortController(), promise: Promise.resolve([] as Buffer[]) };
    const jobKey = `${command.libraryId}:${command.sessionGeneration}:${command.assetId}`;
    audioJob.promise = convertAudio(sourcePath, audioJob.controller.signal);
    activeAudioJobs.set(jobKey, audioJob);
    let windows: Buffer[];
    try {
      windows = await hooks.runWithoutAdmission(() => audioJob.promise);
    } finally {
      if (activeAudioJobs.get(jobKey) === audioJob) activeAudioJobs.delete(jobKey);
    }
    currentSession(command.libraryId, command.sessionGeneration);
    // Recheck source identity after conversion; an asset may be deleted or replaced while FFmpeg runs.
    const [currentAsset] = service.listAssets({ libraryId: command.libraryId, recursive: true, assetIds: [command.assetId] });
    const currentSource = currentAsset && sourceForAsset(currentAsset, [command.kind]);
    if (!currentSource || currentSource.revision !== command.sourceRevision) {
      throw new Error('Semantic asset revision changed during audio preparation.');
    }
    const audioHandle = randomUUID();
    audioHandles.set(audioHandle, { libraryId: command.libraryId, generation: command.sessionGeneration, windows });
    return {
      ok: true,
      type: 'semantic.index.prepared',
      assetId: asset.assetId,
      sourceRevision: source.revision,
      kind: 'audio',
      audioHandle,
      audioWindowCount: windows.length,
    };
  }

  if (command.type === 'semantic.index.audio-window') {
    const audio = audioHandles.get(command.audioHandle);
    if (!audio || audio.libraryId !== command.libraryId || audio.generation !== command.sessionGeneration) {
      throw new Error('Audio payload handle is stale.');
    }
    const bytes = audio.windows[command.windowIndex];
    if (!bytes) throw new Error('Audio window is unavailable.');
    return { ok: true, type: 'semantic.index.audio-window', audioHandle: command.audioHandle,
      windowIndex: command.windowIndex, bytesBase64: bytes.toString('base64') };
  }
  if (command.type === 'semantic.index.audio.release') {
    const audio = audioHandles.get(command.audioHandle);
    if (audio?.libraryId === command.libraryId && audio.generation === command.sessionGeneration) {
      audioHandles.delete(command.audioHandle);
    }
    return { ok: true, type: 'semantic.index.audio-released' };
  }

  if (command.type === 'semantic.index.search' || command.type === 'semantic.index.similar') {
    const profileKey = command.profileKey;
    if (profileKey !== session.profile.profileKey) throw new Error('Semantic profile changed.');
    const filters = command.filters ?? [];
    const scope = command.scope ?? null;
    const queryId = command.queryId;
    try {
    let similarSourceVector: Float32Array | null = null;
    if (command.type === 'semantic.index.similar') {
      const [source] = service.getSemanticAssetSources(command.libraryId, [command.sourceAssetId]);
      const sourcePlan = source && sourceForAsset(source, session.modalities);
      similarSourceVector = sourcePlan
        ? session.store.vectorFor(session.profileId, command.sourceAssetId, sourcePlan.revision)
        : null;
      if (!similarSourceVector) {
        const cancelled = cancelledSearches.get(command.libraryId)?.has(queryId) ?? false;
        if (cancelled) clearCancelledQuery(command.libraryId, queryId);
        const job = sourcePlan ? session.store.jobFor(session.profileId, command.sourceAssetId) : null;
        const sourceStatus = !source || !sourcePlan
          ? 'unsupported'
          : job?.sourceRevision === sourcePlan.revision && job.status === 'failed' ? 'failed' : 'preparing';
        return {
          ok: true,
          type: 'semantic.index.ranked',
          cancelled,
          candidateCount: 0,
          ...(cancelled ? {} : { sourceStatus }),
          ...(!cancelled && source && sourcePlan && sourceStatus === 'preparing' ? { sourceTarget: {
            assetId: source.assetId,
            sourceRevision: sourcePlan.revision,
            kind: sourcePlan.kind,
            modality: sourcePlan.kind,
          } } : {}),
          assetIds: [],
          scores: [],
        };
      }
    }
    const candidateIds: string[] = [];
    let total = 0;
    let snapshot: number | null = null;
    const sourceEpoch = service.getChangeSequence(command.libraryId);
    const wasCancelled = (): boolean => cancelledSearches.get(command.libraryId)?.has(queryId) ?? false;
    const cancelledResult = (candidateCount: number) => ({
      ok: true as const,
      type: 'semantic.index.ranked' as const,
      cancelled: true,
      candidateCount,
      assetIds: [] as string[],
      scores: [] as Array<{ assetId: string; score: number }>,
    });
    if (wasCancelled()) return cancelledResult(0);
    const candidateStart = performance.now();
    const browseStart = service.getBrowseChangeSequence(command.libraryId);
    const firstPage = service.searchAssets({
      libraryId: command.libraryId,
      query: null,
      filters,
      scope,
      showIgnored: command.type === 'semantic.index.search' ? command.showIgnored === true : false,
      idsOnly: true,
    });
    snapshot = browseStart;
    total = firstPage.total;
    candidateIds.push(...(firstPage.assetIds ?? []));
    if (service.getBrowseChangeSequence(command.libraryId) !== snapshot) {
      throw new Error('Semantic search scope changed; retry query.');
    }
    if (candidateIds.length > MAX_CANDIDATES) throw new Error('Semantic candidate set exceeds the supported limit.');
    await hooks.runWithoutAdmission(() => new Promise<void>((resolve) => setImmediate(resolve)));
    if (sessions.get(command.libraryId) !== session) throw new Error('Semantic index session changed.');
    if (wasCancelled()) return cancelledResult(candidateIds.length);
    let offset = candidateIds.length;
    while (offset < total) {
      if (cancelledSearches.get(command.libraryId)?.has(queryId)) {
        clearCancelledQuery(command.libraryId, queryId);
        return { ok: true, type: 'semantic.index.ranked', cancelled: true, candidateCount: total, assetIds: [], scores: [] };
      }
      const before = service.getBrowseChangeSequence(command.libraryId);
      if (snapshot !== null && snapshot !== before) throw new Error('Semantic search scope changed; retry query.');
      snapshot = before;
      const page = service.searchAssets({
        libraryId: command.libraryId,
        query: null,
        filters,
        scope,
        showIgnored: command.type === 'semantic.index.search' ? command.showIgnored === true : false,
        idsOnly: true,
        idsPage: true,
        limit: TARGET_PAGE_SIZE,
        offset,
      });
      total = page.total;
      candidateIds.push(...(page.assetIds ?? []));
      offset += TARGET_PAGE_SIZE;
      const after = service.getBrowseChangeSequence(command.libraryId);
      if (after !== snapshot) throw new Error('Semantic search scope changed; retry query.');
      if (candidateIds.length > MAX_CANDIDATES) throw new Error('Semantic candidate set exceeds the supported limit.');
      await hooks.runWithoutAdmission(() => new Promise<void>((resolve) => setImmediate(resolve)));
      if (sessions.get(command.libraryId) !== session) throw new Error('Semantic index session changed.');
      if (wasCancelled()) return cancelledResult(candidateIds.length);
    }
    hooks.onTiming?.('candidateIds', performance.now() - candidateStart);
    const revisions = new Map<string, string>();
    const revisionStart = performance.now();
    for (let start = 0; start < candidateIds.length; start += TARGET_PAGE_SIZE) {
      if (wasCancelled()) return cancelledResult(candidateIds.length);
      const assets = service.getSemanticAssetSources(command.libraryId,
        candidateIds.slice(start, start + TARGET_PAGE_SIZE));
      for (const asset of assets) {
        const source = sourceForAsset(asset, session.modalities);
        if (source) revisions.set(asset.assetId, source.revision);
      }
      await hooks.runWithoutAdmission(() => new Promise<void>((resolve) => setImmediate(resolve)));
      if (sessions.get(command.libraryId) !== session) throw new Error('Semantic index session changed.');
      if (wasCancelled()) return cancelledResult(candidateIds.length);
    }
    hooks.onTiming?.('sourceProjection', performance.now() - revisionStart);
    let query: readonly number[] | Float32Array;
    let similarSourceStatus: 'ready' | 'preparing' | 'unsupported' | undefined;
    if (command.type === 'semantic.index.similar') {
      similarSourceStatus = 'ready';
      query = similarSourceVector!;
      const sourceIndex = candidateIds.indexOf(command.sourceAssetId);
      if (sourceIndex >= 0) candidateIds.splice(sourceIndex, 1);
      revisions.delete(command.sourceAssetId);
    } else {
      query = command.vector;
    }
    const scores = await session.store.rank({
      profileId: session.profileId,
      query,
      liveRevisions: revisions,
      candidateAssetIds: candidateIds,
      yieldAdmission: () => hooks.runWithoutAdmission(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      ),
      onTiming: hooks.onTiming,
      shouldContinue: () => sessions.get(command.libraryId) === session
        && !cancelledSearches.get(command.libraryId)?.has(queryId)
        && service.getBrowseChangeSequence(command.libraryId) === snapshot,
    });
    let sourceSnapshotValid = true;
    let finalSourceEpoch = sourceEpoch;
    if (scores !== null && service.getChangeSequence(command.libraryId) !== sourceEpoch) {
      // The broad sequence also advances for jobs. Only when it changed do a
      // narrow re-read; require a stable epoch around that projection so an
      // artifact update cannot race between pages and result publication.
      finalSourceEpoch = service.getChangeSequence(command.libraryId);
      for (let start = 0; start < candidateIds.length; start += TARGET_PAGE_SIZE) {
        if (wasCancelled()) return cancelledResult(candidateIds.length);
        const assets = service.getSemanticAssetSources(command.libraryId,
          candidateIds.slice(start, start + TARGET_PAGE_SIZE));
        const current = new Map(assets.map((asset) => [asset.assetId, sourceForAsset(asset, session.modalities)?.revision] as const));
        if (candidateIds.slice(start, start + TARGET_PAGE_SIZE).some((assetId) => current.get(assetId) !== revisions.get(assetId))) {
          sourceSnapshotValid = false;
          break;
        }
        await hooks.runWithoutAdmission(() => new Promise<void>((resolve) => setImmediate(resolve)));
        if (service.getChangeSequence(command.libraryId) !== finalSourceEpoch) {
          sourceSnapshotValid = false;
          break;
        }
        if (wasCancelled()) return cancelledResult(candidateIds.length);
      }
      sourceSnapshotValid &&= service.getChangeSequence(command.libraryId) === finalSourceEpoch;
    }
    const stillCurrent = sourceSnapshotValid && sessions.get(command.libraryId) === session
      && !cancelledSearches.get(command.libraryId)?.has(queryId)
      && service.getBrowseChangeSequence(command.libraryId) === snapshot
      && service.getChangeSequence(command.libraryId) === finalSourceEpoch;
    clearCancelledQuery(command.libraryId, queryId);
    return stillCurrent ? {
        ok: true,
        type: 'semantic.index.ranked',
        cancelled: scores === null,
        candidateCount: candidateIds.length,
        ...(similarSourceStatus ? { sourceStatus: similarSourceStatus } : {}),
        assetIds: scores?.map(({ assetId }) => assetId) ?? [],
        scores: scores ?? [],
      }
      : { ok: true, type: 'semantic.index.ranked', cancelled: true, candidateCount: candidateIds.length, assetIds: [], scores: [] };
    } finally {
      clearCancelledQuery(command.libraryId, queryId);
    }
  }
  return undefined;
}

export async function closeSemanticIndexWorkerLibrary(libraryId?: string): Promise<void> {
  const entries = libraryId === undefined ? [...sessions.entries()] : [...sessions.entries()].filter(([id]) => id === libraryId);
  for (const [id, session] of entries) {
    if (sessions.get(id) === session) sessions.delete(id);
    cancelledSearches.delete(id);
  }
  const audioJobs = [...activeAudioJobs.entries()].filter(([key]) => libraryId === undefined || key.startsWith(`${libraryId}:`));
  for (const [, job] of audioJobs) job.controller.abort();
  await Promise.allSettled(audioJobs.map(([, job]) => job.promise));
  const videoJobs = [...activeVideoJobs.entries()].filter(([key]) => libraryId === undefined || key.startsWith(`${libraryId}:`));
  for (const [, job] of videoJobs) job.controller.abort();
  await Promise.allSettled(videoJobs.map(([, job]) => job.promise));
  for (const [handle, audio] of audioHandles) {
    if (libraryId === undefined || audio.libraryId === libraryId) audioHandles.delete(handle);
  }
  for (const [, session] of entries) {
    session.store.close();
  }
}
