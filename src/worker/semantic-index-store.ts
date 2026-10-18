import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statfsSync } from 'node:fs';
import { endianness } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import Database from 'better-sqlite3';
import { getLoadablePath as getSqliteVecLoadablePath } from 'sqlite-vec';

export const SEMANTIC_SCHEMA_VERSION = 3;
const MAX_VECTOR_DIMENSIONS = 8192;
const MAX_WRITE_BATCH = 128;
const MAX_JOB_BATCH = 500;
const QUERY_CHUNK_SIZE = 256;
const MAX_QUERY_CANDIDATES = 100_000;

function ensureSemanticDatabasePath(libraryPath: string): string {
  const libraryRoot = realpathSync(libraryPath);
  const worldlineboxDirectory = path.join(libraryRoot, '.worldlinebox');
  const worldlineboxInfo = lstatSync(worldlineboxDirectory);
  if (!worldlineboxInfo.isDirectory() || worldlineboxInfo.isSymbolicLink()) {
    throw new Error('The semantic index directory is not a safe library directory.');
  }
  const semanticDirectory = path.join(worldlineboxDirectory, 'semantic');
  try {
    lstatSync(semanticDirectory);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    mkdirSync(semanticDirectory);
  }
  const semanticInfo = lstatSync(semanticDirectory);
  if (!semanticInfo.isDirectory() || semanticInfo.isSymbolicLink()) {
    throw new Error('The semantic index directory is not a safe library directory.');
  }
  const databasePath = path.join(semanticDirectory, 'index.sqlite');
  try {
    const databaseInfo = lstatSync(databasePath);
    if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) {
      throw new Error('The semantic index file is not a safe library file.');
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return databasePath;
}

function semanticDatabasePathForExistingLibrary(libraryPath: string): string {
  const root = realpathSync(libraryPath);
  const worldlineboxDirectory = path.join(root, '.worldlinebox');
  const worldlineboxInfo = lstatSync(worldlineboxDirectory);
  if (!worldlineboxInfo.isDirectory() || worldlineboxInfo.isSymbolicLink()) throw new Error('Unsafe library metadata directory.');
  const semanticDirectory = path.join(worldlineboxDirectory, 'semantic');
  const semanticInfo = lstatSync(semanticDirectory);
  if (!semanticInfo.isDirectory() || semanticInfo.isSymbolicLink()) throw new Error('Unsafe semantic index directory.');
  const databasePath = path.join(semanticDirectory, 'index.sqlite');
  const databaseInfo = lstatSync(databasePath);
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) throw new Error('Unsafe semantic index file.');
  if (realpathSync(databasePath) !== databasePath) throw new Error('Semantic index path escaped its library.');
  return databasePath;
}

/** Explicitly discard only the derived sidecar after a user-requested rebuild. */
export function removeSemanticIndexForRebuild(libraryPath: string, libraryId: string): boolean {
  const databasePath = semanticDatabasePathForExistingLibrary(libraryPath);
  const free = statfsSync(path.dirname(databasePath));
  const freeBytes = Number(free.bavail) * Number(free.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < 64 * 1024 * 1024) {
    throw new Error('Not enough library disk space to rebuild the semantic index.');
  }
  let probe: SqliteDatabase | null = null;
  try {
    probe = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true });
    const version = Number(probe.pragma('user_version', { simple: true }));
    if (version > SEMANTIC_SCHEMA_VERSION) throw new Error('Semantic index schema is newer than this application.');
    const identity = probe.prepare("SELECT value FROM index_meta WHERE key = 'library_id'").get() as
      { value: string } | undefined;
    if (identity && identity.value !== libraryId) throw new Error('Semantic index belongs to another library.');
  } catch (error) {
    if (error instanceof Error && /newer than this application|belongs to another library/u.test(error.message)) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (!['SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_ERROR', 'SQLITE_CANTOPEN'].includes(code)) throw error;
  } finally {
    probe?.close();
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = `${databasePath}${suffix}`;
    try {
      const info = lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe semantic sidecar component.');
      rmSync(candidate);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return true;
}

async function backupSqliteDatabase(source: SqliteDatabase, destinationPath: string, libraryId: string): Promise<void> {
  if (existsSync(destinationPath)) throw new Error('Semantic index backup destination already exists.');
  const pageCount = Number(source.pragma('page_count', { simple: true }));
  const pageSize = Number(source.pragma('page_size', { simple: true }));
  const estimatedBytes = pageCount * pageSize;
  const free = statfsSync(path.dirname(destinationPath));
  const freeBytes = Number(free.bavail) * Number(free.bsize);
  const requiredBytes = Math.max(32 * 1024 * 1024, estimatedBytes * 2 + 16 * 1024 * 1024);
  if (!Number.isFinite(requiredBytes) || freeBytes < requiredBytes) {
    throw new Error('Not enough destination disk space for a semantic index backup.');
  }
  try {
    await source.backup(destinationPath);
    const backup = new BetterSqlite(destinationPath, { readonly: true, fileMustExist: true });
    try {
      const version = backup.pragma('user_version', { simple: true }) as number;
      const identity = backup.prepare("SELECT value FROM index_meta WHERE key = 'library_id'").get() as
        { value: string } | undefined;
      if (version !== SEMANTIC_SCHEMA_VERSION || identity?.value !== libraryId) {
        throw new Error('Semantic index backup failed identity or schema verification.');
      }
    } finally {
      backup.close();
    }
  } catch (error) {
    // The destination was absent before this operation, so only its partial
    // SQLite files are ours to remove.
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${destinationPath}${suffix}`, { force: true });
    throw error;
  }
}

/** Snapshot an inactive sidecar without applying migrations or touching job state. */
export async function backupExistingSemanticIndexFile(input: {
  libraryPath: string;
  libraryId: string;
  destinationPath: string;
}): Promise<void> {
  const sourcePath = semanticDatabasePathForExistingLibrary(input.libraryPath);
  const source = new BetterSqlite(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const version = source.pragma('user_version', { simple: true }) as number;
    const identity = source.prepare("SELECT value FROM index_meta WHERE key = 'library_id'").get() as
      { value: string } | undefined;
    if (version !== SEMANTIC_SCHEMA_VERSION || identity?.value !== input.libraryId) {
      throw new Error('Semantic index is incompatible with the requested library snapshot.');
    }
    await backupSqliteDatabase(source, input.destinationPath, input.libraryId);
  } finally {
    source.close();
  }
}

export type SemanticVectorProfile = {
  profileKey: string;
  dimensions: number;
  modelRevision: string;
  modality: 'image' | 'audio' | 'text' | 'mixed';
};

export type SemanticVectorInput = {
  assetId: string;
  sourceRevision: string;
  vector: readonly number[];
  claimToken?: string;
};

export type SemanticVectorScore = { assetId: string; score: number };

type ProfileRow = { profile_id: string; dimensions: number; model_revision: string };
type VectorRow = { asset_id: string; vector: Buffer };
type SqliteStatement = {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
};
type SqliteDatabase = {
  open: boolean;
  close(): void;
  exec(sql: string): void;
  loadExtension(file: string, entrypoint?: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(operation: () => T): () => T;
  backup(filename: string): Promise<unknown>;
};
type SqliteConstructor = new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDatabase;
const BetterSqlite = Database as SqliteConstructor;

function validateDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_VECTOR_DIMENSIONS) {
    throw new Error('Semantic vector dimensions are outside the supported range.');
  }
}

function loadPinnedVectorExtension(database: SqliteDatabase): void {
  const extensionPath = realpathSync(getSqliteVecLoadablePath());
  if (!path.basename(extensionPath).startsWith('vec0.')) {
    throw new Error('The sqlite-vec extension did not resolve to its pinned package resource.');
  }
  const runtime = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean };
  if (process.versions.electron && runtime.defaultApp === false && runtime.resourcesPath) {
    const relative = path.relative(realpathSync(runtime.resourcesPath), extensionPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('The sqlite-vec extension is outside packaged application resources.');
    }
  }
  // Load precisely the path that was checked above. Calling sqlite-vec's
  // convenience loader here would resolve the resource a second time, outside
  // this boundary check.
  database.loadExtension(extensionPath);
}

export function encodeSemanticVector(vector: readonly number[] | Float32Array, dimensions: number): Buffer {
  validateDimensions(dimensions);
  if (vector.length !== dimensions) throw new Error('Semantic vector dimensions do not match its profile.');
  const bytes = Buffer.allocUnsafe(dimensions * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let maxMagnitude = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = vector[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Semantic vectors must contain finite values.');
    }
    maxMagnitude = Math.max(maxMagnitude, Math.abs(value));
  }
  if (maxMagnitude === 0) {
    throw new Error('Semantic vectors must have a non-zero finite norm.');
  }
  let scaledNormSquared = 0;
  for (const value of vector) scaledNormSquared += (value / maxMagnitude) ** 2;
  const scaledNorm = Math.sqrt(scaledNormSquared);
  let floatNormSquared = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = (vector[index] ?? 0) / maxMagnitude / scaledNorm;
    view.setFloat32(index * 4, value, true);
    const rounded = view.getFloat32(index * 4, true);
    if (!Number.isFinite(rounded)) throw new Error('Semantic vector cannot be represented as Float32.');
    floatNormSquared += rounded * rounded;
  }
  if (!Number.isFinite(floatNormSquared) || floatNormSquared === 0) {
    throw new Error('Semantic vector cannot be represented as a non-zero Float32 vector.');
  }
  // Renormalize after Float32 rounding so both SQLite and fallback paths use
  // the same unit vector representation.
  const floatNorm = Math.sqrt(floatNormSquared);
  for (let index = 0; index < dimensions; index += 1) {
    view.setFloat32(index * 4, view.getFloat32(index * 4, true) / floatNorm, true);
  }
  return bytes;
}

function decodeSemanticVector(bytes: Buffer, dimensions: number): Float32Array {
  if (bytes.byteLength !== dimensions * 4) throw new Error('Stored semantic vector has an invalid length.');
  const values = new Float32Array(dimensions);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < dimensions; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) throw new Error('Stored semantic vector contains a non-finite value.');
    values[index] = value;
  }
  return values;
}

function profileId(profileKey: string): string {
  if (!profileKey || profileKey.length > 4096) throw new Error('Semantic profile key is invalid.');
  return createHash('sha256').update(profileKey).digest('hex');
}

function cosineScores(
  query: readonly number[] | Float32Array,
  rows: readonly VectorRow[],
  dimensions: number,
): SemanticVectorScore[] {
  const scores: SemanticVectorScore[] = [];
  for (const row of rows) {
    const vector = decodeSemanticVector(row.vector, dimensions);
    let score = 0;
    for (let index = 0; index < dimensions; index += 1) {
      score += (query[index] ?? 0) * (vector[index] ?? 0);
    }
    scores.push({ assetId: row.asset_id, score });
  }
  return scores;
}

export function compareSemanticScores(left: SemanticVectorScore, right: SemanticVectorScore): number {
  return right.score - left.score || left.assetId.localeCompare(right.assetId);
}

/**
 * A library-relative vector sidecar. The owning Worker is the only caller;
 * this class never opens the primary catalog database.
 */
export class SemanticIndexStore {
  readonly #libraryId: string;
  readonly #database: SqliteDatabase;
  readonly #hasVecCosine: boolean;
  readonly #upsert: SqliteStatement;
  readonly #deleteRevision: SqliteStatement;
  readonly #removeAsset: SqliteStatement;
  readonly #profile: SqliteStatement;

  constructor(input: {
    libraryPath: string;
    libraryId: string;
    storageKind: 'local' | 'network' | 'unknown';
    /** Test seam for proving fallback equivalence without the native extension. */
    loadNativeExtension?: (database: SqliteDatabase) => void;
  }) {
    this.#libraryId = input.libraryId;
    const databasePath = ensureSemanticDatabasePath(input.libraryPath);
    // Future schema files are only probed read-only. Do not change their
    // journal mode, pragmas, or contents with an older application.
    let existingVersion: number | null = null;
    try {
      const probe = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true });
      try {
        existingVersion = probe.pragma('user_version', { simple: true }) as number;
      } finally {
        probe.close();
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'SQLITE_CANTOPEN')) throw error;
    }
    if (existingVersion !== null && existingVersion > SEMANTIC_SCHEMA_VERSION) {
      throw new Error('Semantic index schema is newer than this application.');
    }
    const database = new BetterSqlite(databasePath);
    try {
      this.#database = database;
      this.#database.pragma('foreign_keys = ON');
      this.#database.pragma(`journal_mode = ${input.storageKind === 'local' ? 'WAL' : 'DELETE'}`);
      this.#database.pragma('synchronous = FULL');
      this.#database.pragma('busy_timeout = 5000');
      this.#database.pragma('cache_size = -16384');
      this.#createSchema(input.libraryId);
      // A worker can disappear while a provider request is in flight. Requeue
      // durable claims on the next open; committed vectors remain reusable.
      this.#database.prepare("UPDATE embedding_jobs SET status = 'pending', claim_token = NULL, updated_at = ? WHERE status = 'running'")
        .run(new Date().toISOString());
      let hasVecCosine = false;
      try {
        if (endianness() !== 'LE') throw new Error('sqlite-vec requires a little-endian host.');
        (input.loadNativeExtension ?? loadPinnedVectorExtension)(this.#database);
        this.#database.prepare("SELECT vec_distance_cosine(?, ?) AS distance").get(
          encodeSemanticVector([1], 1), encodeSemanticVector([1], 1),
        );
        hasVecCosine = true;
      } catch {
        // A missing/incompatible native extension must not affect ordinary library use.
      }
      this.#hasVecCosine = hasVecCosine;
      this.#profile = this.#database.prepare(
        'SELECT profile_id, dimensions, model_revision FROM embedding_profiles WHERE profile_id = ?',
      );
      this.#upsert = this.#database.prepare(`
        INSERT INTO asset_embeddings (profile_id, asset_id, source_revision, dimensions, vector, updated_at)
        VALUES (@profileId, @assetId, @sourceRevision, @dimensions, @vector, @updatedAt)
        ON CONFLICT(profile_id, asset_id) DO UPDATE SET
          source_revision = excluded.source_revision,
          dimensions = excluded.dimensions,
          vector = excluded.vector,
          updated_at = excluded.updated_at
      `);
      this.#deleteRevision = this.#database.prepare(
        'DELETE FROM asset_embeddings WHERE profile_id = ? AND asset_id = ? AND source_revision <> ?',
      );
      this.#removeAsset = this.#database.prepare('DELETE FROM asset_embeddings WHERE asset_id = ?');
    } catch (error) {
      if (database.open) database.close();
      throw error;
    }
  }

  get nativeCosineAvailable(): boolean {
    return this.#hasVecCosine;
  }

  get journalMode(): string {
    return String(this.#database.pragma('journal_mode', { simple: true }));
  }

  close(): void {
    if (this.#database.open) this.#database.close();
  }

  ensureProfile(profile: SemanticVectorProfile): string {
    validateDimensions(profile.dimensions);
    if (!profile.modelRevision || profile.modelRevision.length > 1024) {
      throw new Error('Semantic model revision is invalid.');
    }
    const id = profileId(profile.profileKey);
    const current = this.#profile.get(id) as ProfileRow | undefined;
    const now = new Date().toISOString();
    if (current && (current.dimensions !== profile.dimensions || current.model_revision !== profile.modelRevision)) {
      const reset = this.#database.transaction(() => {
        this.#database.prepare('DELETE FROM asset_embeddings WHERE profile_id = ?').run(id);
        this.#database.prepare('DELETE FROM embedding_jobs WHERE profile_id = ?').run(id);
        this.#database.prepare('UPDATE embedding_profiles SET dimensions = ?, model_revision = ?, modality = ?, updated_at = ? WHERE profile_id = ?')
          .run(profile.dimensions, profile.modelRevision, profile.modality, now, id);
      });
      reset();
    } else {
      this.#database.prepare(`
        INSERT INTO embedding_profiles (profile_id, profile_key_hash, dimensions, model_revision, modality, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET enabled = 1, modality = excluded.modality, updated_at = excluded.updated_at
      `).run(id, id, profile.dimensions, profile.modelRevision, profile.modality, now, now);
    }
    return id;
  }

  markPending(profileIdValue: string, assetId: string, sourceRevision: string): void {
    this.markPendingBatch(profileIdValue, [{ assetId, sourceRevision }]);
  }

  markPendingBatch(profileIdValue: string, jobs: ReadonlyArray<{ assetId: string; sourceRevision: string }>): void {
    if (jobs.length > MAX_JOB_BATCH) throw new Error('Semantic job batch is too large.');
    const upsert = this.#database.prepare(`
      INSERT INTO embedding_jobs (profile_id, asset_id, source_revision, status, attempts, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?)
      ON CONFLICT(profile_id, asset_id) DO UPDATE SET source_revision = excluded.source_revision,
        status = CASE WHEN embedding_jobs.source_revision = excluded.source_revision
            AND embedding_jobs.status = 'running' THEN 'running'
          WHEN embedding_jobs.source_revision = excluded.source_revision
            AND embedding_jobs.status = 'failed' AND embedding_jobs.retry_after > excluded.updated_at
          THEN 'failed' ELSE 'pending' END,
        retry_after = CASE WHEN embedding_jobs.source_revision = excluded.source_revision
            AND embedding_jobs.status = 'running' THEN embedding_jobs.retry_after
          WHEN embedding_jobs.source_revision = excluded.source_revision
            AND embedding_jobs.status = 'failed' AND embedding_jobs.retry_after > excluded.updated_at
          THEN embedding_jobs.retry_after ELSE NULL END,
        error_category = CASE WHEN embedding_jobs.source_revision = excluded.source_revision
            AND embedding_jobs.status = 'running' THEN embedding_jobs.error_category
          WHEN embedding_jobs.source_revision = excluded.source_revision
            AND embedding_jobs.status = 'failed' AND embedding_jobs.retry_after > excluded.updated_at
          THEN embedding_jobs.error_category ELSE NULL END,
        claim_token = CASE WHEN embedding_jobs.source_revision = excluded.source_revision
            AND embedding_jobs.status = 'running' THEN embedding_jobs.claim_token ELSE NULL END,
        updated_at = excluded.updated_at
    `);
    const transaction = this.#database.transaction(() => {
      const timestamp = new Date().toISOString();
      for (const job of jobs) {
        upsert.run(profileIdValue, job.assetId, job.sourceRevision, timestamp);
        this.#deleteRevision.run(profileIdValue, job.assetId, job.sourceRevision);
      }
    });
    transaction();
  }

  markRunning(profileIdValue: string, assetId: string, sourceRevision: string, claimToken: string): boolean {
    const result = this.#database.prepare(`
      UPDATE embedding_jobs SET status = 'running', claim_token = ?, attempts = attempts + 1, updated_at = ?
      WHERE profile_id = ? AND asset_id = ? AND source_revision = ?
        AND (status = 'pending' OR (status = 'failed' AND (retry_after IS NULL OR retry_after <= ?)))
    `).run(claimToken, new Date().toISOString(), profileIdValue, assetId, sourceRevision,
      new Date().toISOString()) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  markFailed(profileIdValue: string, assetId: string, sourceRevision: string, claimToken: string, category: string): void {
    this.#database.prepare(`
      UPDATE embedding_jobs SET status = 'failed', error_category = ?,
        retry_after = ?, updated_at = ?, claim_token = NULL
      WHERE profile_id = ? AND asset_id = ? AND source_revision = ? AND status = 'running' AND claim_token = ?
    `).run(category, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(),
      profileIdValue, assetId, sourceRevision, claimToken);
  }

  jobFor(profileIdValue: string, assetId: string): {
    sourceRevision: string;
    status: 'pending' | 'running' | 'ready' | 'failed';
    attempts: number;
    errorCategory: string | null;
    retryAfter: string | null;
  } | null {
    const row = this.#database.prepare(`
      SELECT source_revision, status, attempts, error_category, retry_after FROM embedding_jobs
      WHERE profile_id = ? AND asset_id = ?
    `).get(profileIdValue, assetId) as {
      source_revision: string; status: 'pending' | 'running' | 'ready' | 'failed';
      attempts: number; error_category: string | null; retry_after: string | null;
    } | undefined;
    if (!row) return null;
    const retryDue = row.status === 'failed'
      && (!row.retry_after || row.retry_after <= new Date().toISOString());
    return {
      sourceRevision: row.source_revision,
      status: retryDue ? 'pending' : row.status,
      attempts: row.attempts,
      errorCategory: row.error_category,
      retryAfter: row.retry_after,
    };
  }

  upsertBatch(profileIdValue: string, inputs: readonly SemanticVectorInput[]): {
    accepted: string[];
    rejected: string[];
  } {
    if (inputs.length > MAX_WRITE_BATCH) throw new Error('Semantic vector batch is too large.');
    const profile = this.#profile.get(profileIdValue) as ProfileRow | undefined;
    if (!profile) throw new Error('Semantic vector profile is unavailable.');
    const prepared: Array<{ assetId: string; sourceRevision: string; vector: Buffer; claimToken?: string }> = [];
    const rejected: string[] = [];
    const accepted: string[] = [];
    for (const item of inputs) {
      if (!item.assetId || item.assetId.length > 255 || !item.sourceRevision || item.sourceRevision.length > 4096) {
        rejected.push(item.assetId);
        continue;
      }
      try {
        prepared.push({
          assetId: item.assetId,
          sourceRevision: item.sourceRevision,
          vector: encodeSemanticVector(item.vector, profile.dimensions),
          ...(item.claimToken ? { claimToken: item.claimToken } : {}),
        });
      } catch {
        rejected.push(item.assetId);
      }
    }
    const finishJob = this.#database.prepare(`
      UPDATE embedding_jobs SET status = 'ready', retry_after = NULL,
        error_category = NULL, claim_token = NULL, updated_at = @at
      WHERE profile_id = @profileId AND asset_id = @assetId AND source_revision = @sourceRevision
        AND (@claimToken IS NULL OR (status = 'running' AND claim_token = @claimToken))
    `);
    const write = this.#database.transaction(() => {
      for (const item of prepared) {
        if (item.claimToken) {
          const claim = this.#database.prepare(`SELECT 1 FROM embedding_jobs WHERE profile_id = ?
            AND asset_id = ? AND source_revision = ? AND status = 'running' AND claim_token = ?`)
            .get(profileIdValue, item.assetId, item.sourceRevision, item.claimToken);
          if (!claim) {
            rejected.push(item.assetId);
            continue;
          }
        }
        this.#upsert.run({
          profileId: profileIdValue,
          assetId: item.assetId,
          sourceRevision: item.sourceRevision,
          dimensions: profile.dimensions,
          vector: item.vector,
          updatedAt: new Date().toISOString(),
        });
        finishJob.run({ at: new Date().toISOString(), profileId: profileIdValue, assetId: item.assetId,
          sourceRevision: item.sourceRevision, claimToken: item.claimToken ?? null });
        accepted.push(item.assetId);
      }
    });
    write();
    return { accepted, rejected };
  }

  removeStale(profileIdValue: string, liveRevisions: ReadonlyMap<string, string>): void {
    const remove = this.#database.prepare('DELETE FROM asset_embeddings WHERE profile_id = ? AND asset_id = ?');
    const current = this.#database.prepare('SELECT asset_id, source_revision FROM asset_embeddings WHERE profile_id = ?');
    const rows = current.all(profileIdValue) as Array<{ asset_id: string; source_revision: string }>;
    const stale = rows.filter((row) => liveRevisions.get(row.asset_id) !== row.source_revision);
    const removeJob = this.#database.prepare(`DELETE FROM embedding_jobs WHERE profile_id = ? AND asset_id = ?
      AND source_revision <> ?`);
    const tx = this.#database.transaction(() => {
      for (const row of stale) {
        remove.run(profileIdValue, row.asset_id);
        removeJob.run(profileIdValue, row.asset_id, liveRevisions.get(row.asset_id) ?? '');
      }
    });
    tx();
  }

  vectorSources(profileIdValue: string): Array<{ assetId: string; sourceRevision: string }> {
    return (this.#database.prepare('SELECT asset_id, source_revision FROM asset_embeddings WHERE profile_id = ?')
      .all(profileIdValue) as Array<{ asset_id: string; source_revision: string }>).map((row) => ({
      assetId: row.asset_id,
      sourceRevision: row.source_revision,
    }));
  }

  legacyImportFor(contentDigest: string, profileIdValue: string): { processMarker: string; acceptedRows: number } | null {
    const row = this.#database.prepare(`SELECT process_marker, accepted_rows FROM legacy_imports
      WHERE content_digest = ? AND profile_id = ?`).get(contentDigest, profileIdValue) as
      { process_marker: string; accepted_rows: number } | undefined;
    return row ? { processMarker: row.process_marker, acceptedRows: row.accepted_rows } : null;
  }

  recordLegacyImport(input: { contentDigest: string; profileId: string; acceptedRows: number;
    rejectedRows: number; processMarker: string }): void {
    this.#database.prepare(`INSERT INTO legacy_imports
      (content_digest, profile_id, accepted_rows, rejected_rows, completed_at, process_marker)
      VALUES (@contentDigest, @profileId, @acceptedRows, @rejectedRows, @completedAt, @processMarker)
      ON CONFLICT(content_digest) DO NOTHING`).run({ ...input, completedAt: new Date().toISOString() });
  }

  removeAsset(assetId: string): void {
    const removeJob = this.#database.prepare('DELETE FROM embedding_jobs WHERE asset_id = ?');
    const remove = this.#database.transaction(() => {
      this.#removeAsset.run(assetId);
      removeJob.run(assetId);
    });
    remove();
  }

  count(profileIdValue: string): number {
    const row = this.#database.prepare('SELECT COUNT(*) AS count FROM asset_embeddings WHERE profile_id = ?')
      .get(profileIdValue) as { count: number };
    return row.count;
  }

  vectorFor(profileIdValue: string, assetId: string, sourceRevision: string): Float32Array | null {
    const profile = this.#profile.get(profileIdValue) as ProfileRow | undefined;
    if (!profile) return null;
    const row = this.#database.prepare(
      'SELECT vector FROM asset_embeddings WHERE profile_id = ? AND asset_id = ? AND source_revision = ? AND dimensions = ?',
    ).get(profileIdValue, assetId, sourceRevision, profile.dimensions) as { vector: Buffer } | undefined;
    return row ? decodeSemanticVector(row.vector, profile.dimensions) : null;
  }

  hasVector(profileIdValue: string, assetId: string, sourceRevision: string): boolean {
    return this.#database.prepare(
      'SELECT 1 AS ready FROM asset_embeddings WHERE profile_id = ? AND asset_id = ? AND source_revision = ?',
    ).get(profileIdValue, assetId, sourceRevision) !== undefined;
  }

  removeVector(profileIdValue: string, assetId: string, sourceRevision: string): void {
    const removeVector = this.#database.prepare(`DELETE FROM asset_embeddings
      WHERE profile_id = ? AND asset_id = ? AND source_revision = ?`);
    const removeJob = this.#database.prepare(`DELETE FROM embedding_jobs
      WHERE profile_id = ? AND asset_id = ? AND source_revision = ?`);
    const remove = this.#database.transaction(() => {
      removeVector.run(profileIdValue, assetId, sourceRevision);
      removeJob.run(profileIdValue, assetId, sourceRevision);
    });
    remove();
  }

  hasRunningClaim(profileIdValue: string, assetId: string, sourceRevision: string, claimToken: string): boolean {
    return this.#database.prepare(`SELECT 1 FROM embedding_jobs WHERE profile_id = ? AND asset_id = ?
      AND source_revision = ? AND status = 'running' AND claim_token = ?`)
      .get(profileIdValue, assetId, sourceRevision, claimToken) !== undefined;
  }

  async backupTo(destinationPath: string): Promise<void> {
    await backupSqliteDatabase(this.#database, destinationPath, this.#libraryId);
  }

  async rank(input: {
    profileId: string;
    query: readonly number[] | Float32Array;
    liveRevisions: ReadonlyMap<string, string>;
    candidateAssetIds: readonly string[];
    shouldContinue?: () => boolean;
    yieldAdmission?: () => Promise<void>;
    onTiming?: (phase: string, durationMs: number) => void;
  }): Promise<SemanticVectorScore[] | null> {
    const profile = this.#profile.get(input.profileId) as ProfileRow | undefined;
    if (!profile) return [];
    if (input.candidateAssetIds.length > MAX_QUERY_CANDIDATES) {
      throw new Error('Semantic query candidate set exceeds the supported limit.');
    }
    const queryBlob = encodeSemanticVector(input.query, profile.dimensions);
    const revisions = input.liveRevisions;
    const scores: SemanticVectorScore[] = [];
    const rankStart = performance.now();
    for (let start = 0; start < input.candidateAssetIds.length; start += QUERY_CHUNK_SIZE) {
      if (input.shouldContinue?.() === false) return null;
      const ids = input.candidateAssetIds.slice(start, start + QUERY_CHUNK_SIZE);
      if (ids.length === 0) continue;
      const placeholders = ids.map(() => '?').join(',');
      if (this.#hasVecCosine) {
        const vectorScores = this.#database.prepare(`
          SELECT asset_id AS assetId, source_revision AS sourceRevision,
                 1.0 - vec_distance_cosine(vector, ?) AS score
          FROM asset_embeddings
          WHERE profile_id = ? AND asset_id IN (${placeholders}) AND dimensions = ?
        `).all(queryBlob, input.profileId, ...ids, profile.dimensions) as Array<SemanticVectorScore & { sourceRevision: string }>;
        scores.push(...vectorScores
          .filter((row) => revisions.get(row.assetId) === row.sourceRevision && Number.isFinite(row.score))
          .map(({ assetId, score }) => ({ assetId, score })));
      } else {
        const rows = this.#database.prepare(`
          SELECT asset_id, source_revision, vector
          FROM asset_embeddings
          WHERE profile_id = ? AND asset_id IN (${placeholders}) AND dimensions = ?
        `).all(input.profileId, ...ids, profile.dimensions) as Array<VectorRow & { source_revision: string }>;
        const currentRows = rows.filter((row) => revisions.get(row.asset_id) === row.source_revision);
        scores.push(...cosineScores(decodeSemanticVector(queryBlob, profile.dimensions), currentRows, profile.dimensions));
      }
      // Release scheduler admission as well as the JS event loop between
      // bounded scans so browse/close/cancel commands can actually run.
      if (input.yieldAdmission) await input.yieldAdmission();
      else await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (input.shouldContinue?.() === false) return null;
    input.onTiming?.('vectorScan', performance.now() - rankStart);
    const sortStart = performance.now();
    scores.sort(compareSemanticScores);
    input.onTiming?.('scoreSort', performance.now() - sortStart);
    return scores;
  }

  #createSchema(libraryId: string): void {
    const version = this.#database.pragma('user_version', { simple: true }) as number;
    if (version > SEMANTIC_SCHEMA_VERSION) throw new Error('Semantic index schema is newer than this application.');
    const create = this.#database.transaction(() => {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS index_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS embedding_profiles (
          profile_id TEXT PRIMARY KEY,
          profile_key_hash TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND ${MAX_VECTOR_DIMENSIONS}),
          model_revision TEXT NOT NULL,
          modality TEXT NOT NULL CHECK(modality IN ('image', 'audio', 'text', 'mixed')),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_embeddings (
          profile_id TEXT NOT NULL REFERENCES embedding_profiles(profile_id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL,
          source_revision TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND ${MAX_VECTOR_DIMENSIONS}),
          vector BLOB NOT NULL CHECK(typeof(vector) = 'blob' AND length(vector) = dimensions * 4),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(profile_id, asset_id)
        );
        CREATE INDEX IF NOT EXISTS asset_embeddings_revision_idx
          ON asset_embeddings(profile_id, source_revision);
        CREATE TABLE IF NOT EXISTS embedding_jobs (
          profile_id TEXT NOT NULL REFERENCES embedding_profiles(profile_id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL,
          source_revision TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'ready', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          retry_after TEXT,
          error_category TEXT,
          claim_token TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(profile_id, asset_id)
        );
        CREATE TABLE IF NOT EXISTS legacy_imports (
          content_digest TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES embedding_profiles(profile_id),
          accepted_rows INTEGER NOT NULL CHECK(accepted_rows >= 0),
          rejected_rows INTEGER NOT NULL CHECK(rejected_rows >= 0),
          completed_at TEXT NOT NULL,
          process_marker TEXT NOT NULL DEFAULT ''
        );
      `);
      const jobColumns = this.#database.prepare('PRAGMA table_info(embedding_jobs)').all() as Array<{ name: string }>;
      if (!jobColumns.some((column) => column.name === 'claim_token')) {
        this.#database.exec('ALTER TABLE embedding_jobs ADD COLUMN claim_token TEXT');
      }
      const importColumns = this.#database.prepare('PRAGMA table_info(legacy_imports)').all() as Array<{ name: string }>;
      if (!importColumns.some((column) => column.name === 'process_marker')) {
        this.#database.exec("ALTER TABLE legacy_imports ADD COLUMN process_marker TEXT NOT NULL DEFAULT ''");
      }
      const storedLibraryId = this.#database.prepare("SELECT value FROM index_meta WHERE key = 'library_id'")
        .get() as { value: string } | undefined;
      if (storedLibraryId && storedLibraryId.value !== libraryId) {
        throw new Error('Semantic index belongs to another library identity.');
      }
      this.#database.prepare("INSERT INTO index_meta (key, value) VALUES ('library_id', ?) ON CONFLICT(key) DO NOTHING")
        .run(libraryId);
      this.#database.prepare("INSERT INTO index_meta (key, value) VALUES ('format', 'float32-le-v1') ON CONFLICT(key) DO NOTHING")
        .run();
      this.#database.pragma(`user_version = ${SEMANTIC_SCHEMA_VERSION}`);
    });
    create();
  }
}
