import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { z } from 'zod';
import type { VcpMemoryPreparedPayload, VcpMemoryPreparedRecall, VcpMemoryPreprocessResult } from './contracts';
import { VcpPreparedRecallDiskBudget, type PreparedRecallDiskLimits, type PreparedRecallDiskTurn } from './prepared-recall-budget';
import { writeDurablePreparedFile } from './durable-prepared-write';
import { preparedRecallRecoverySchema, recoveryFromPayload } from './prepared-recall-recovery';
import { companionPreparedRecallReferenceSchema, type CompanionPreparedRecallReference } from '../../shared/companion-prepared-recall';

const TTL_MS = 10 * 60 * 1000;
const MAX_RESIDENT_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
// JSON escaping can double the serialized body. Candidate references remain
// in the immutable handle, while the full recovery proof occurs once in body.
const MAX_ENVELOPE_BYTES = MAX_PACKAGE_BYTES * 4 + 1024 * 1024;
const MAX_PACKAGES_PER_SCOPE = 64;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const preparedRecallHostEvidenceSchema = z.strictObject({
  schema: z.literal('worldlinebox.prepared-recall-host-evidence'), ownerId: z.string().min(1).max(4096),
  revocationEpoch: z.number().int().nonnegative().safe(), capturedAt: z.string().datetime({ offset: true }), sourceClosureDigest: digestSchema,
  recovery: preparedRecallRecoverySchema.optional(),
});
const preparedHandleHostEvidenceSchema = preparedRecallHostEvidenceSchema.omit({ recovery: true });
function projectPreparedHostEvidence(evidence: z.infer<typeof preparedRecallHostEvidenceSchema>) {
  return preparedHandleHostEvidenceSchema.parse({ schema: evidence.schema, ownerId: evidence.ownerId, revocationEpoch: evidence.revocationEpoch,
    capturedAt: evidence.capturedAt, sourceClosureDigest: evidence.sourceClosureDigest });
}
const preparedHandleSchema = z.strictObject({ schema: z.literal('worldlinebox.prepared-recall-v2'),
  id: z.string().regex(/^prepared_[a-f0-9]{32}$/u), scopeId: z.string().min(1).max(4096), contentHash: digestSchema,
  createdAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }), corpusEpoch: z.number().int().nonnegative().safe(),
  contextReferences: z.array(z.strictObject({ id: z.string().min(1), role: z.enum(['returned', 'focus_input']), sourceFile: z.string().optional(), textHash: digestSchema })),
  contextReferenceCoverage: z.enum(['observed', 'partial']), queryClock: z.strictObject({ now: z.string().datetime({ offset: true }), timeZone: z.string().min(1) }).optional(),
  hostEvidence: preparedHandleHostEvidenceSchema.optional(),
});
// Shared accounting across generation clients, not 32 MiB per companion.
const resident = new Map<string, { value: string; bytes: number }>();
let residentBytes = 0;
let activeBodyBytes = 0, activeBodies = 0;
interface BodyWaiter { bytes: number; signal?: AbortSignal; abort?(): void; accept(release: () => void): void; reject(reason: unknown): void }
const bodyWaiters: BodyWaiter[] = [];
const claimedFiles = new Set<string>();
const savingScopes = new Map<string, Promise<unknown>>();
const fileIdentity = (file: string) => process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file);
function pumpBodies(): void {
  while (bodyWaiters.length) {
    const next = bodyWaiters[0]!;
    // Oversize legal inputs are admitted alone. They stay on disk while
    // waiting, and are never truncated to fit the normal serialized-body cap.
    if (activeBodies && activeBodyBytes + next.bytes > MAX_RESIDENT_BYTES) return;
    bodyWaiters.shift(); next.signal?.removeEventListener('abort', next.abort!);
    while (resident.size && residentBytes + activeBodyBytes + next.bytes > MAX_RESIDENT_BYTES) forgetResident(resident.keys().next().value!);
    activeBodies++; activeBodyBytes += next.bytes;
    let released = false;
    next.accept(() => { if (!released) { released = true; activeBodies--; activeBodyBytes -= next.bytes; pumpBodies(); } });
  }
}
function reserveBody(bytes: number, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((accept, reject) => {
    const entry: BodyWaiter = { bytes, signal, accept, reject };
    entry.abort = () => { const index = bodyWaiters.indexOf(entry); if (index < 0) return;
      bodyWaiters.splice(index, 1); signal?.removeEventListener('abort', entry.abort!); reject(signal?.reason); pumpBodies(); };
    bodyWaiters.push(entry); signal?.addEventListener('abort', entry.abort, { once: true }); pumpBodies();
  });
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Envelope = { schema: 'worldlinebox.prepared-recall-envelope-v3'; handle: VcpMemoryPreparedRecall; serialized: string };
const preparedEnvelopeSchema = z.strictObject({ schema: z.literal('worldlinebox.prepared-recall-envelope-v3'), handle: preparedHandleSchema, serialized: z.string() });
const focusRecordSchema = z.strictObject({ schema: z.literal('worldlinebox.prepared-focus-result-v1'), hash: digestSchema, serialized: z.string() });
interface PreparedLease { payload: VcpMemoryPreparedPayload; handle: VcpMemoryPreparedRecall; focused?: { hash: string; receipt: VcpMemoryPreprocessResult }; release(): void }
function forgetResident(file: string): void {
  const value = resident.get(file); if (value) residentBytes -= value.bytes;
  resident.delete(file);
}
function retain(file: string, value: string): void {
  forgetResident(file); const bytes = Buffer.byteLength(value);
  if (activeBodyBytes + bytes > MAX_RESIDENT_BYTES) return;
  while (residentBytes + activeBodyBytes + bytes > MAX_RESIDENT_BYTES && resident.size) forgetResident(resident.keys().next().value!);
  resident.set(file, { value, bytes }); residentBytes += bytes;
}

/** Workspace/scope-owned immutable candidates. Worker LRU retirement never
 * invalidates these bytes; owner interruption/asset-library close does. */
export class VcpPreparedRecallStore {
  private readonly knownScopes = new Set<string>();
  private readonly active = new Set<string>();
  private readonly disk: VcpPreparedRecallDiskBudget;
  private closing?: Promise<void>;
  constructor(private readonly dataRoot: string, options: PreparedRecallDiskLimits & { workspaceRoot?: string } = {}) {
    if (!path.isAbsolute(dataRoot)) throw new Error('Prepared recall root must be absolute.');
    this.disk = new VcpPreparedRecallDiskBudget(options.workspaceRoot ?? dataRoot, dataRoot, options);
  }
  private diskTurn<T>(operation: (turn: PreparedRecallDiskTurn) => Promise<T>): Promise<T> {
    return this.disk.run(operation, file => claimedFiles.has(fileIdentity(file)), forgetResident);
  }
  private directory(scopeId: string): string {
    if (!scopeId.trim() || scopeId.length > 4096) throw new Error('Invalid prepared scope.');
    return path.join(this.dataRoot, hash(scopeId), 'prepared-recalls');
  }
  private file(handle: Pick<VcpMemoryPreparedRecall, 'id' | 'scopeId'>): string {
    if (!/^prepared_[a-f0-9]{32}$/u.test(handle.id)) throw new Error('Invalid prepared recall ID.');
    return path.join(this.directory(handle.scopeId), handle.id + '.json');
  }
  private async checkDirectory(scopeId: string, create: boolean): Promise<string> {
    const directory = this.directory(scopeId);
    let target = path.parse(directory).root;
    // Validate each existing ancestor before creating a child. Recursive mkdir
    // would follow a junction before the old post-creation check could reject it.
    for (const segment of path.relative(target, directory).split(path.sep)) {
      target = path.join(target, segment);
      let info;
      try { info = await lstat(target); }
      catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        info = await lstat(target);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Prepared recall directory must remain owned and unlinked.');
    }
    return directory;
  }
  save(scopeId: string, payload: VcpMemoryPreparedPayload): Promise<VcpMemoryPreparedRecall> {
    if (this.closing) return Promise.reject(new Error('Prepared recall store is closed.'));
    const key = fileIdentity(this.directory(scopeId));
    const operation = (savingScopes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.saveNow(scopeId, payload));
    savingScopes.set(key, operation);
    void operation.finally(() => { if (savingScopes.get(key) === operation) savingScopes.delete(key); }).catch(() => undefined);
    return operation;
  }
  private async saveNow(scopeId: string, payload: VcpMemoryPreparedPayload): Promise<VcpMemoryPreparedRecall> {
    if (payload.hostEvidence) preparedRecallHostEvidenceSchema.parse(payload.hostEvidence);
    const directory = await this.checkDirectory(scopeId, true);
    this.knownScopes.add(scopeId);
    return this.diskTurn(async turn => {
    const files = (await readdir(directory)).filter(name => /^prepared_[a-f0-9]{32}\.json$/u.test(name));
    if (files.length >= MAX_PACKAGES_PER_SCOPE) throw Object.assign(new Error('Prepared recall capacity is busy.'), { code: 'VCP_MEMORY_PREPARED_CAPACITY' });
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > MAX_PACKAGE_BYTES) throw Object.assign(new Error('Prepared recall exceeds the transport package limit; use bounded source stages.'), { code: 'VCP_MEMORY_PREPARED_CAPACITY' });
    const created = Date.now();
    const handle: VcpMemoryPreparedRecall = { schema: 'worldlinebox.prepared-recall-v2',
      id: 'prepared_' + randomUUID().replaceAll('-', ''), scopeId, contentHash: hash(serialized),
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + TTL_MS).toISOString(),
      corpusEpoch: payload.receipt.receiptCache?.corpusEpoch ?? 0,
      contextReferences: structuredClone(payload.receipt.contextReferences ?? []),
      contextReferenceCoverage: payload.receipt.contextReferenceCoverage ?? 'partial',
      ...(payload.hostEvidence ? { hostEvidence: projectPreparedHostEvidence(payload.hostEvidence) } : {}),
      ...(payload.receipt.queryClock ? { queryClock: { ...payload.receipt.queryClock } } : {}) };
    preparedHandleSchema.parse(handle);
    const file = this.file(handle), temporary = file + '.tmp';
    const envelope = JSON.stringify({ schema: 'worldlinebox.prepared-recall-envelope-v3', handle, serialized } satisfies Envelope) + '\n', bytes = Buffer.byteLength(envelope);
    if (bytes > MAX_ENVELOPE_BYTES) throw Object.assign(new Error('Prepared recall envelope exceeds its transport capacity.'), { code: 'VCP_MEMORY_PREPARED_CAPACITY' });
    turn.admit(bytes);
    // Reserve disk before I/O. If a failed write cannot clean its temporary
    // file, the reservation remains charged until verified TTL recovery.
    turn.committed(temporary, bytes);
    try {
      await writeDurablePreparedFile(temporary, file, envelope);
      turn.removed(temporary); turn.committed(file, bytes);
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      turn.removed(temporary);
    }
    retain(file, serialized);
    return handle;
    });
  }
  acquire(handle: VcpMemoryPreparedRecall, signal?: AbortSignal): Promise<PreparedLease> { return this.acquireFile(handle, false, signal); }
  acquireReference(reference: CompanionPreparedRecallReference, signal?: AbortSignal): Promise<PreparedLease> {
    companionPreparedRecallReferenceSchema.parse(reference); return this.acquireFile(reference, true, signal);
  }
  private async acquireFile(selector: VcpMemoryPreparedRecall | CompanionPreparedRecallReference, reference: boolean, signal?: AbortSignal): Promise<PreparedLease> {
    if (this.closing) throw new Error('Prepared recall store is closed.');
    const selectedHandle = reference ? undefined : preparedHandleSchema.parse(selector);
    if (!Number.isFinite(Date.parse(selector.expiresAt)) || Date.parse(selector.expiresAt) <= Date.now()) throw new Error('Prepared recall has expired.');
    await this.checkDirectory(selector.scopeId, false); this.knownScopes.add(selector.scopeId);
    const file = this.file(selector);
    const claim = fileIdentity(file);
    if (claimedFiles.has(claim)) throw Object.assign(new Error('Prepared recall is already being focused.'), { code: 'VCP_MEMORY_PREPARED_BUSY' });
    this.active.add(file); claimedFiles.add(claim);
    let releaseBody: (() => void) | undefined;
    try {
      // A restarted host must reconstruct all workspace bytes, including an
      // interrupted result tail, before admitting or extending this package.
      await this.diskTurn(async () => undefined);
      // The disk envelope binds the caller's handle even when the body is in LRU.
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ENVELOPE_BYTES) throw new Error('Invalid prepared recall package.');
      releaseBody = await reserveBody(info.size, signal);
      signal?.throwIfAborted();
      const raw = await readFile(file, 'utf8'), end = raw.indexOf('\n'), header = end < 0 ? raw : raw.slice(0, end);
      const envelope = preparedEnvelopeSchema.parse(JSON.parse(header));
      signal?.throwIfAborted();
      if (envelope.schema !== 'worldlinebox.prepared-recall-envelope-v3') throw new Error('Invalid prepared recall envelope schema.');
      const handle = preparedHandleSchema.parse(envelope.handle);
      if (typeof envelope.serialized !== 'string' || Buffer.byteLength(envelope.serialized) > MAX_PACKAGE_BYTES) throw new Error('Invalid prepared recall body size.');
      if (reference ? handle.id !== selector.id || handle.scopeId !== selector.scopeId || handle.contentHash !== selector.contentHash || handle.expiresAt !== selector.expiresAt
        : JSON.stringify(handle) !== JSON.stringify(selectedHandle)) throw new Error('Prepared recall handle fingerprint has changed.');
      if (hash(envelope.serialized) !== handle.contentHash) throw new Error('Prepared recall fingerprint has changed.');
      const cached = resident.get(file)?.value;
      const serialized = cached && hash(cached) === handle.contentHash ? cached : envelope.serialized;
      // The active body owns its accounting until release. Keeping a second
      // serialized LRU copy here would double-count every waiting focus.
      forgetResident(file);
      const payload = JSON.parse(serialized) as VcpMemoryPreparedPayload;
      if (payload.schema !== 'worldlinebox.prepared-recall-payload') throw new Error('Invalid prepared recall schema.');
      if (JSON.stringify(payload.hostEvidence ? projectPreparedHostEvidence(preparedRecallHostEvidenceSchema.parse(payload.hostEvidence)) : undefined) !== JSON.stringify(handle.hostEvidence))
        throw new Error('Prepared recall owner evidence has changed.');
      if (reference) {
        const locator = selector as CompanionPreparedRecallReference, recovery = recoveryFromPayload(payload);
        if (locator.ownerId !== payload.hostEvidence?.ownerId || locator.taskKey !== recovery.taskKey || locator.profileKey !== recovery.profileKey)
          throw new Error('Prepared recall task or owner evidence has changed.');
      }
      let focused: PreparedLease['focused'];
      const expectedFocusHash = reference ? (selector as CompanionPreparedRecallReference).focusHash : undefined;
      // Only a checksum anchored in the trusted task checkpoint authorizes
      // reuse. An unanchored or interrupted tail is never a model receipt.
      if (expectedFocusHash) {
        const tail = end < 0 ? '' : raw.slice(end + 1);
        if (!tail.endsWith('\n') || tail.slice(0, -1).includes('\n')) throw new Error('Prepared focus result has an incomplete tail.');
        const record = focusRecordSchema.parse(JSON.parse(tail.slice(0, -1)));
        if (record.hash !== expectedFocusHash || hash(record.serialized) !== expectedFocusHash) throw new Error('Prepared focus result fingerprint has changed.');
        const receipt = JSON.parse(record.serialized) as VcpMemoryPreprocessResult;
        if (!receipt || !Array.isArray(receipt.messages) || !Array.isArray(receipt.events)
          || receipt.messages.some(message => !message || typeof message.role !== 'string' || !(typeof message.content === 'string' || Array.isArray(message.content))))
          throw new Error('Prepared focus result schema is invalid.');
        focused = { hash: record.hash, receipt };
      }
      let released = false;
      return { payload, handle, ...(focused ? { focused } : {}), release: () => { if (!released) { released = true; this.active.delete(file); claimedFiles.delete(claim); releaseBody?.(); } } };
    } catch (error) { releaseBody?.(); this.active.delete(file); claimedFiles.delete(claim); throw error; }
  }
  async completeFocus(handle: VcpMemoryPreparedRecall, receipt: VcpMemoryPreprocessResult): Promise<string> {
    if (this.closing) throw new Error('Prepared recall store is closed.');
    const directory = await this.checkDirectory(handle.scopeId, false), file = this.file(handle);
    if (path.dirname(file) !== directory || !this.active.has(file)) throw new Error('Prepared focus completion requires its active package lease.');
    const serialized = JSON.stringify(receipt), resultHash = hash(serialized);
    if (Buffer.byteLength(serialized) > MAX_PACKAGE_BYTES) throw Object.assign(new Error('Prepared focus result exceeds its transport capacity.'), { code: 'VCP_MEMORY_PREPARED_CAPACITY' });
    const record = JSON.stringify({ schema: 'worldlinebox.prepared-focus-result-v1', hash: resultHash, serialized }) + '\n';
    await this.diskTurn(async turn => {
      const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Prepared focus file is not owned.');
      const raw = await readFile(file, 'utf8'), end = raw.indexOf('\n');
      if (end < 0) throw new Error('Prepared focus package has no durable header boundary.');
      const header = raw.slice(0, end + 1), bytes = Buffer.byteLength(header) + Buffer.byteLength(record);
      if (bytes > MAX_ENVELOPE_BYTES) throw Object.assign(new Error('Prepared focus envelope exceeds its transport capacity.'), { code: 'VCP_MEMORY_PREPARED_CAPACITY' });
      turn.grow(file, Math.max(0, bytes - info.size));
      const output = await open(file, 'r+');
      try {
        const position = Buffer.byteLength(header), buffer = Buffer.from(record, 'utf8'); await output.truncate(position);
        for (let offset = 0; offset < buffer.length;) {
          const written = await output.write(buffer, offset, buffer.length - offset, position + offset);
          if (!written.bytesWritten) throw new Error('Prepared focus receipt write made no progress.'); offset += written.bytesWritten;
        }
        await output.sync();
      }
      finally { await output.close(); const actual = await lstat(file); turn.committed(file, actual.size); }
    });
    return resultHash;
  }
  async remove(handle: Pick<VcpMemoryPreparedRecall, 'id' | 'scopeId'>): Promise<void> {
    if (this.closing) { await this.closing; return; }
    const file = this.file(handle);
    // A duplicate caller which failed admission cannot discard another store's
    // active claim. Hard scope withdrawal uses purgeScope after abort/drain.
    if (claimedFiles.has(fileIdentity(file)) && !this.active.has(file)) return;
    forgetResident(file);
    await this.diskTurn(async turn => {
      await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      turn.removed(file);
    });
  }
  async prune(scopeId: string): Promise<void> {
    this.directory(scopeId); await this.diskTurn(async () => undefined);
  }
  async purgeScope(scopeId: string): Promise<void> {
    if (this.closing) { await this.closing; return; }
    await this.purgeScopeFiles(scopeId);
  }
  private async purgeScopeFiles(scopeId: string, duringClose = false): Promise<void> {
    let directory: string;
    try { directory = await this.checkDirectory(scopeId, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    // Hard withdrawal also closes the owner client. A scope interrupt can be
    // draining its model while that close finishes. Join its complete cleanup
    // instead of trying to reopen a workspace budget already released by it.
    if (!duringClose && this.closing) { await this.closing; return; }
    await this.diskTurn(async turn => { for (const name of await readdir(directory)) {
      if (!/^prepared_[a-f0-9]{32}\.json(?:\.tmp)?$/u.test(name)) continue;
      const file = path.join(directory, name); forgetResident(file);
      // unlink never follows a link or recursively traverses an external path.
      await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      turn.removed(file);
    } });
  }
  close(): Promise<void> { return this.closing ??= (async () => {
    try { await Promise.all([...this.knownScopes].map(scope => this.purgeScopeFiles(scope, true))); }
    finally { await this.disk.close(); }
  })(); }
  snapshot() { return { residentBytes, activeBodyBytes, activeBodies, bodyWaiters: bodyWaiters.length,
    // This counts serialized candidates, not total JavaScript heap/RSS. An
    // oversize body is observable and exclusively admitted, never hidden.
    oversizedBody: activeBodyBytes > MAX_RESIDENT_BYTES, maxResidentBytes: MAX_RESIDENT_BYTES,
    ...this.disk.snapshot(), active: this.active.size, maxPackagesPerScope: MAX_PACKAGES_PER_SCOPE, ttlMs: TTL_MS }; }
}
