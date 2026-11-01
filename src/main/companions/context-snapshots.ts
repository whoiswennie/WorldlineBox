import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { companionContextSnapshotSchema, companionContextSnapshotSummarySchema, type CompanionContextSnapshot } from '../../shared/companion-cognition';
import type { CompanionArtifact, CompanionArtifactReference } from '../../shared/companion-artifact';
import { companionArtifactReferenceSchema } from '../../shared/companion-artifact';
import type { CompanionArtifactPublish, CompanionArtifactRegistry } from './artifact-registry';
import type { CompanionTransportAttempt, CompanionTransportAttemptInput } from './model';
import type { CompanionRegistryPublication } from '../../shared/companion-registry-storage';
import { createCompanionExecutionValidationSession, detachedCompanionExecutionValidation, withCompanionExecutionValidation } from './source-execution-evidence';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const snapshotId = z.string().regex(/^ctx_[a-f0-9]{32}$/u);
const legacyIndexSchema = z.strictObject({ schema: z.literal('worldlinebox.companion-context-index-v2'), companionId: z.string(), ids: z.array(snapshotId).max(40), retiredCount: z.number().int().nonnegative() });
const stateSchema = companionContextSnapshotSummarySchema.extend({ revocationEpoch: z.number().int().nonnegative() });
const indexEntrySchema = z.strictObject({ state: stateSchema, revision: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/u), body: companionArtifactReferenceSchema }).superRefine((value, context) => {
  if (hash(JSON.stringify(value.state)) !== value.hash) context.addIssue({ code: 'custom', message: 'Lifecycle summary does not match its exact published state bytes.' });
});
const lifecycleIndexSchema = z.strictObject({ schema: z.literal('worldlinebox.companion-context-index-v3'), companionId: z.string(),
  ids: z.array(snapshotId).max(40), entries: z.array(indexEntrySchema).max(40), retiring: z.array(snapshotId).max(40),
  retiredCount: z.number().int().nonnegative() }).superRefine((value, context) => {
  if (new Set([...value.ids, ...value.retiring]).size !== value.ids.length + value.retiring.length || value.ids.length + value.retiring.length > 40
    || value.ids.length !== value.entries.length || value.entries.some((entry, index) => entry.state.id !== value.ids[index] || entry.state.companionId !== value.companionId))
    context.addIssue({ code: 'custom', message: 'Lifecycle index identity/order/coverage is inconsistent.' });
});
const indexSchema = z.union([lifecycleIndexSchema, legacyIndexSchema]);
type LifecycleIndex = z.infer<typeof lifecycleIndexSchema>;
type IndexEntry = z.infer<typeof indexEntrySchema>;
type IndexRead = { artifact?: CompanionArtifact; value: z.infer<typeof indexSchema> };
type AdmittedIndex = { artifact?: CompanionArtifact; value: LifecycleIndex };
const states = new Map<string, Promise<unknown>>();
const MAX_BODY_BYTES = 6 * 1024 * 1024;
export class CompanionUnknownContextAttemptError extends Error { readonly code = 'CONTEXT_RECORD_FAILED'; }
export interface CompanionContextSnapshotsOptions {
  artifacts(ownerId: string): Promise<CompanionArtifactRegistry>;
  /** Exact host-owned namespace; used only by irreversible owner retirement. */
  ownerDirectory?(ownerId: string): string;
  currentRevocationEpoch(ownerId: string): Promise<number>;
  /** Host ACL/revocation checks use actual source versions, never guessed IDs
   * parsed from user prose. No body is returned until this succeeds. */
  validateRead(snapshot: CompanionContextSnapshot): Promise<void>;
  /** Exact registered references from the host's admitted read set. */
  references?(input: CompanionTransportAttemptInput): Promise<{ sourceRefs: CompanionArtifactReference[]; dependencyRefs: CompanionArtifactReference[] }>;
  maxSnapshotsPerOwner?: number;
}
function visualManifest(body: unknown): CompanionContextSnapshot['visualManifest'] {
  const result: CompanionContextSnapshot['visualManifest'] = [], pending: Array<{ value: unknown; pointer: string; key: string; parent?: Record<string, unknown> }> = [{ value: body, pointer: '', key: '' }];
  let visited = 0;
  while (pending.length) {
    if (++visited > 300_000) throw new Error('实际请求结构超过审计预算，未截断保存。');
    const { value, pointer, key, parent } = pending.pop()!;
    if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) pending.push({ value: child, pointer: pointer + '/' + name.replaceAll('~', '~0').replaceAll('/', '~1'), key: name, parent: Array.isArray(value) ? undefined : value as Record<string, unknown> });
    } else if (typeof value === 'string') {
      const inline = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
      const encoded = key === 'data' && parent && (typeof parent.mimeType === 'string' || parent.type === 'base64' && typeof parent.media_type === 'string');
      if (inline || encoded) {
        const data = inline?.[2] ?? value, mime = inline?.[1] ?? String(parent?.mimeType ?? parent?.media_type);
        if (!/^image\//u.test(mime)) continue;
        const bytes = Buffer.from(data, 'base64');
        result.push({ pointer, delivery: 'inline_bytes', mime, bytes: bytes.length, sha256: hash(bytes) });
      } else if ((key === 'image' || key === 'url' && /image_url/u.test(pointer)) && /^https?:\/\//u.test(value)) result.push({ pointer, delivery: 'remote_url', url: value });
      if (result.length > 128) throw new Error('视觉证据清单超过上限，未截断保存。');
    }
  }
  return result;
}
function summary(snapshot: CompanionContextSnapshot) {
  const { frame, providerBody: _body, visualManifest, toolDeclarations, ...metadata } = snapshot; void _body;
  return companionContextSnapshotSummarySchema.parse({ ...metadata, profileRevision: frame.profileRevision, conversationId: frame.conversationId, taskId: frame.taskId, invocationId: frame.invocationId, structuredRepair: frame.structuredRepair, visualCount: visualManifest.length, toolDeclarationBytes: Buffer.byteLength(toolDeclarations) });
}
/** A formal registry index, not a directory scan. Payloads are immutable;
 * attempt state is a separate small artifact. Old attempts retire explicitly. */
export class CompanionContextSnapshots {
  readonly retentionLimit: number;
  readonly bodyLimitBytes = MAX_BODY_BYTES;
  constructor(private readonly options: CompanionContextSnapshotsOptions) { this.retentionLimit = Math.max(4, Math.min(40, options.maxSnapshotsPerOwner ?? 24)); }
  private serial<T>(owner: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); let started = false;
    const pending = (states.get(owner) ?? Promise.resolve()).catch(() => undefined).then(() => {
      signal?.throwIfAborted(); started = true; return work();
    }); states.set(owner, pending);
    void pending.finally(() => { if (states.get(owner) === pending) states.delete(owner); }).catch(() => undefined);
    if (!signal) return pending;
    // Only work still waiting for the owner can leave the queue immediately.
    // Once started, the read gate observes cancellation; durable publication
    // must finish rather than leaving an orphaned half-published attempt.
    return new Promise<T>((resolve, reject) => {
      const abort = () => { if (!started) reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  /** A bounded journal read shares the writer queue until its private final
   * file/SQL fence settles. It never retains a lock across HTTP. */
  private async readInJournal<T>(owner: string, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const window = createCompanionExecutionValidationSession(signal);
    try {
      return await this.serial(owner, async () => {
        const result = await window.run(read);
        await window.validate();
        return result;
      }, signal);
    } finally { window.close(); }
  }
  private ids(id: string) { snapshotId.parse(id); return { body: `context:${id}`, state: `context-state:${id}`, base: `.运行/上下文/${id}` }; }
  private async index(owner: string, registry: CompanionArtifactRegistry): Promise<IndexRead> {
    const artifact = await registry.get('context-index:recent');
    if (!artifact) {
      if (await registry.get('context-index:recent', true) || (await registry.page({ kind: 'context_snapshot', includeRevoked: true, limit: 1 })).items.length)
        throw new Error('已有上下文的正式生命周期索引缺失或撤回，不能重建为空索引。');
      return { value: { schema: 'worldlinebox.companion-context-index-v3', companionId: owner, ids: [], entries: [], retiring: [], retiredCount: 0 } };
    }
    const result = await registry.read({ artifactId: artifact.artifactId, consumer: 'host' }), value = indexSchema.parse(JSON.parse(result.text));
    if (artifact.kind !== 'runtime_index' || value.companionId !== owner) throw new Error('上下文保留索引归属无效。'); return { artifact, value };
  }
  private entry(owner: string, state: z.infer<typeof stateSchema>, artifact: CompanionArtifact): IndexEntry {
    const body = artifact.dependencyRefs[0], ids = this.ids(state.id);
    if (state.companionId !== owner || artifact.ownerId !== owner || artifact.artifactId !== ids.state || artifact.kind !== 'context_snapshot'
      || artifact.relativePath !== ids.base + '/attempt.json' || artifact.producer.kind !== 'host' || artifact.producer.id !== 'provider-transport'
      || artifact.publicationState !== 'committed' || artifact.visibility.scope !== 'owner' || JSON.stringify(artifact.allowedConsumers) !== '["audit"]'
      || artifact.sourceRefs.length || artifact.dependencyRefs.length !== 1 || body?.artifactId !== ids.body)
      throw new Error('上下文生命周期状态的准确归属或权限无效。');
    return indexEntrySchema.parse({ state, revision: artifact.contentRevision, hash: artifact.contentHash, body });
  }
  private async verifyEntries(owner: string, registry: CompanionArtifactRegistry, value: LifecycleIndex): Promise<void> {
    const artifacts = new Map((await registry.getMany(value.entries.map(entry => this.ids(entry.state.id).state), true)).map(artifact => [artifact.artifactId, artifact]));
    for (const entry of value.entries) {
      const artifact = artifacts.get(this.ids(entry.state.id).state);
      if (!artifact || JSON.stringify(this.entry(owner, entry.state, artifact)) !== JSON.stringify(entry)) throw new Error('上下文生命周期索引与当前状态版本不一致。');
    }
    if (!await registry.validateReferences(value.entries.map(entry => ({ artifactId: this.ids(entry.state.id).state, contentRevision: entry.revision, contentHash: entry.hash }))))
      throw new Error('上下文生命周期的当前来源闭包已经变化。');
  }
  private async admittedIndex(owner: string, registry: CompanionArtifactRegistry, supplied?: IndexRead): Promise<AdmittedIndex> {
    return withCompanionExecutionValidation(async () => {
      const index = supplied ?? await this.index(owner, registry);
      if (index.value.schema === 'worldlinebox.companion-context-index-v3') {
        await this.verifyEntries(owner, registry, index.value); return { ...index, value: index.value };
      }
      // Legacy state files remain the authority until one complete, fresh read
      // can be atomically published as the v3 host lifecycle projection.
      const metadata = await registry.getMany(index.value.ids.map(id => this.ids(id).state));
      if (metadata.length !== index.value.ids.length) throw new Error('旧上下文生命周期状态不完整，需先恢复或撤回。');
      const bodies = await registry.readMany(metadata.map(artifact => ({ artifactId: artifact.artifactId, consumer: 'audit' as const })));
      const entries = index.value.ids.map(id => {
        const body = bodies.find(item => item.artifact.artifactId === this.ids(id).state)!;
        return this.entry(owner, stateSchema.parse(JSON.parse(body.text)), body.artifact);
      });
      return { artifact: index.artifact, value: lifecycleIndexSchema.parse({ ...index.value, schema: 'worldlinebox.companion-context-index-v3', entries, retiring: [] }) };
    });
  }
  private indexItem(index: AdmittedIndex): CompanionArtifactPublish {
    return { artifactId: 'context-index:recent', kind: 'runtime_index', producer: { kind: 'host', id: 'provider-transport-index' },
      relativePath: '.运行/索引/上下文.json', expectedRevision: index.artifact?.contentRevision ?? null,
      content: JSON.stringify(lifecycleIndexSchema.parse(index.value)), sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['host'], retentionClass: 'runtime' };
  }
  private async writeState(owner: string, id: string, registry: CompanionArtifactRegistry, current: CompanionArtifact,
    state: z.infer<typeof stateSchema>, index: AdmittedIndex, operationId: string): Promise<void> {
    const previous = index.value.entries.find(entry => entry.state.id === id);
    if (!previous || previous.revision !== current.contentRevision || previous.hash !== current.contentHash) throw new Error('上下文状态不属于当前生命周期索引。');
    const content = JSON.stringify(state), next = indexEntrySchema.parse({ ...previous, state, revision: current.contentRevision + 1, hash: hash(content) });
    await registry.publishBatch({ operationId, items: [
      { artifactId: this.ids(id).state, kind: 'context_snapshot', producer: { kind: 'host', id: 'provider-transport' }, relativePath: this.ids(id).base + '/attempt.json',
        expectedRevision: current.contentRevision, content, sourceRefs: [], dependencyRefs: current.dependencyRefs, visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'ephemeral' },
      this.indexItem({ artifact: index.artifact, value: { ...index.value, entries: index.value.entries.map(entry => entry.state.id === id ? next : entry) } }),
    ] });
  }
  private async load(owner: string, id: string, authorize = true): Promise<CompanionContextSnapshot> {
    const registry = await this.options.artifacts(owner), ids = this.ids(id);
    const allowed = async () => {
      const index = await detachedCompanionExecutionValidation(() => withCompanionExecutionValidation(() => this.index(owner, registry)));
      if (!index.value.ids.includes(id)) throw new Error('本次上下文已经正式退役，正文已停止提供。');
      if (index.value.schema === 'worldlinebox.companion-context-index-v3') {
        const entry = index.value.entries.find(entry => entry.state.id === id);
        if (!entry) throw new Error('本次上下文已经正式退役，正文已停止提供。');
        return entry;
      }
    };
    const window = createCompanionExecutionValidationSession();
    try {
      const captured = await this.serial(owner, () => window.run(async () => {
        const initial = await allowed();
        const body = await registry.read({ artifactId: ids.body, consumer: 'audit' }), state = await registry.read({ artifactId: ids.state, consumer: 'audit' });
        if (body.artifact.kind !== 'context_snapshot' || state.artifact.kind !== 'context_snapshot' || body.artifact.ownerId !== owner || state.artifact.ownerId !== owner) throw new Error('上下文快照归属不一致。');
        const metadata = stateSchema.parse(JSON.parse(state.text));
        if (initial && JSON.stringify(this.entry(owner, metadata, state.artifact)) !== JSON.stringify(initial)) throw new Error('审计状态与正式生命周期索引不一致。');
        const snapshot = companionContextSnapshotSchema.parse({ ...JSON.parse(body.text), status: metadata.status, sentAt: metadata.sentAt, completedAt: metadata.completedAt, httpStatus: metadata.httpStatus });
        if (snapshot.companionId !== owner || snapshot.frame.companionId !== owner || snapshot.id !== id || hash(snapshot.providerBody) !== snapshot.bodyHash) throw new Error('上下文正文、版本或归属校验不一致。');
        return { snapshot, metadata, initial };
      }));
      // Source authorization may wait or request another journal read. It must
      // not hold this owner's publication queue while doing so.
      if (authorize) await window.run(async () => {
        if (captured.metadata.revocationEpoch !== await this.options.currentRevocationEpoch(owner)) throw new Error('本次上下文涉及的来源可能已撤回，正文已停止提供。');
        await this.options.validateRead(captured.snapshot);
      });
      await this.serial(owner, async () => {
        await window.run(async () => {
          const final = await allowed();
          if (JSON.stringify(final) !== JSON.stringify(captured.initial)) throw new Error('审计读取期间生命周期版本已经变化。');
          if (authorize && captured.metadata.revocationEpoch !== await this.options.currentRevocationEpoch(owner)) throw new Error('本次上下文涉及的来源可能已撤回，正文已停止提供。');
        });
        // Reopens every consumed canonical body and metadata after the unlocked
        // source check, while a normal journal publisher cannot replace them.
        await window.validate();
      });
      return captured.snapshot;
    } finally { window.close(); }
  }
  async read(owner: string, id: string): Promise<CompanionContextSnapshot> { return this.load(owner, id); }
  async list(owner: string, limit = 20) {
    return this.readInJournal(owner, () => this.listInJournal(owner, limit));
  }
  private async listInJournal(owner: string, limit: number) {
    const registry = await this.options.artifacts(owner), raw = await this.index(owner, registry);
    // Removal is fail-closed: management may omit officially revoked/missing
    // states without treating them as a valid send or reconstructing bytes.
    const present = new Set((await registry.getMany(raw.value.ids.map(id => this.ids(id).state))).map(artifact => artifact.artifactId));
    const idsPresent = raw.value.ids.filter(id => present.has(this.ids(id).state));
    const value = raw.value.schema === 'worldlinebox.companion-context-index-v3' ? { ...raw.value, ids: idsPresent,
      entries: raw.value.entries.filter(entry => idsPresent.includes(entry.state.id)) } : { ...raw.value, ids: idsPresent };
    const index = await this.admittedIndex(owner, registry, { artifact: raw.artifact, value }), ids = index.value.ids.slice(0, Math.max(1, Math.min(40, limit)));
    const items: z.infer<typeof companionContextSnapshotSummarySchema>[] = [];
    const epoch = await this.options.currentRevocationEpoch(owner);
    for (const id of ids) {
      const { revocationEpoch, ...metadata } = index.value.entries.find(entry => entry.state.id === id)!.state;
      items.push(companionContextSnapshotSummarySchema.parse({ ...metadata, ...(epoch !== revocationEpoch ? { status: 'redacted' } : {}) }));
    }
    return { items, retention: { limit: this.retentionLimit, truncated: index.value.ids.length > ids.length, policy: 'recent_attempts_per_owner' as const, bodyLimitBytes: this.bodyLimitBytes } };
  }
  prepareAttempt(input: CompanionTransportAttemptInput): Promise<CompanionTransportAttempt> {
    // Audit index/state are read-modify-write receipts, not model inputs.
    // Their private reads keep their own fresh registry gates and CAS checks;
    // they must not enter the caller's immutable source dependency ledger.
    return detachedCompanionExecutionValidation(() => this.prepareAttemptInJournal(input));
  }
  private async prepareAttemptInJournal(input: CompanionTransportAttemptInput): Promise<CompanionTransportAttempt> {
    input.signal?.throwIfAborted();
    if (Buffer.byteLength(input.providerBody, 'utf8') > this.bodyLimitBytes) throw new Error('实际请求超过完整快照容量，未截断或发送。');
    const owner = input.frame.companionId, id = 'ctx_' + randomUUID().replaceAll('-', ''), ids = this.ids(id), preparedAt = new Date().toISOString();
    const parsed: unknown = JSON.parse(input.providerBody), body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    const toolDeclarations = JSON.stringify(body.tools ?? (body.parameters && typeof body.parameters === 'object' ? (body.parameters as Record<string, unknown>).tools : undefined) ?? []);
    if (input.frame.revocationEpoch === undefined || input.frame.revocationEpoch !== await this.options.currentRevocationEpoch(owner)) throw new Error('上下文撤销版本已变化或未核实，未发送。');
    const snapshot = companionContextSnapshotSchema.parse({ id, companionId: owner, purpose: input.frame.purpose, preparedAt, status: 'prepared', frame: input.frame, revocationMode: 'conservative_owner_revocation',
      providerFormat: input.providerFormat, model: input.model, providerBody: input.providerBody, bodyHash: hash(input.providerBody), bodyStorage: 'exact', imageFallback: input.imageFallback, visualManifest: visualManifest(parsed), toolDeclarations });
    await this.serial(owner, async () => {
      const registry = await this.options.artifacts(owner), references = await this.options.references?.(input) ?? { sourceRefs: input.frame.sourceRefs ?? [], dependencyRefs: input.frame.dependencyRefs ?? [] };
      let staleIndex = await this.finishRetirements(owner, registry);
      let retiredStale = false;
      if (staleIndex.value.schema === 'worldlinebox.companion-context-index-v3') for (const entry of staleIndex.value.entries)
        if (entry.state.revocationEpoch !== input.frame.revocationEpoch) { await this.retire(owner, entry.state.id, registry); retiredStale = true; }
      if (retiredStale) staleIndex = await this.index(owner, registry);
      const active = await withCompanionExecutionValidation(async () => {
        const active = await this.admittedIndex(owner, registry, staleIndex);
        // v3 is an officially published lifecycle projection, not cached file
        // parsing. Unconsumed old terminal audit bytes cannot change these
        // facts. Direct audit reads still verify their exact registered bytes.
        for (const { state } of active.value.entries) {
          if (state.status === 'unknown' && state.purpose === input.frame.purpose && (input.frame.invocationId ? state.invocationId === input.frame.invocationId : state.bodyHash === snapshot.bodyHash)) throw new CompanionUnknownContextAttemptError('这个调用仍有发送或结果未确认的历史凭证，禁止自动重发。');
        }
        return active;
      }, input.signal);
      input.signal?.throwIfAborted();
      const { index, completedRetirements } = await this.prune(owner, registry, 1, active);
      const state = stateSchema.parse({ ...summary(snapshot), revocationEpoch: input.frame.revocationEpoch }), content = JSON.stringify(snapshot), bodyHash = hash(content);
      const entry = indexEntrySchema.parse({ state, revision: 1, hash: hash(JSON.stringify(state)), body: { artifactId: ids.body, contentRevision: 1, contentHash: bodyHash } });
      if (completedRetirements.some(id => !index.value.retiring.includes(id))) throw new Error('已完成的退役清理不属于本次准确索引。');
      const completed = new Set(completedRetirements);
      const nextIndex = { ...index.value, ids: [id, ...index.value.ids], entries: [entry, ...index.value.entries],
        retiring: index.value.retiring.filter(id => !completed.has(id)) };
      input.signal?.throwIfAborted();
      await registry.publishBatch({ operationId: `context:prepare:${id}`, items: [
        { artifactId: ids.body, kind: 'context_snapshot', producer: { kind: 'host', id: 'provider-transport' }, relativePath: ids.base + '/request.json', expectedRevision: null, content, ...references, visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'ephemeral' },
        { artifactId: ids.state, kind: 'context_snapshot', producer: { kind: 'host', id: 'provider-transport' }, relativePath: ids.base + '/attempt.json', expectedRevision: null, content: JSON.stringify(state), sourceRefs: [], dependencyRefs: [{ artifactId: ids.body, contentRevision: 1, contentHash: bodyHash }], visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'ephemeral' },
        this.indexItem({ artifact: index.artifact, value: nextIndex }),
      ] });
      // The reserved slot and this exact index CAS already enforce retention.
      // Re-reading/pruning the just-committed index adds no admission proof.
    }, input.signal);
    let dispatched = false, complete = false;
    const update = async (status: CompanionContextSnapshot['status'], httpStatus?: number) => this.serial(owner, async () => {
      const registry = await this.options.artifacts(owner), current = await withCompanionExecutionValidation(async () => {
        const registered = await registry.get(ids.state, true);
        // A deliberate privacy withdrawal already discarded this attempt. Do
        // not restore it. Settlement deliberately ignores the preparation's
        // aborted signal so a never-sent attempt can still record cancellation.
        if (registered?.publicationState === 'revoked' || input.frame.revocationEpoch !== await this.options.currentRevocationEpoch(owner)) return;
        const index = await this.admittedIndex(owner, registry);
        return { body: (await registry.readMany([{ artifactId: ids.body, consumer: 'audit' }, { artifactId: ids.state, consumer: 'audit' }]))[1]!, index };
      });
      if (!current) return;
      const state = stateSchema.parse(JSON.parse(current.body.text));
      const next = stateSchema.parse({ ...state, status, ...(status === 'dispatched' ? { sentAt: new Date().toISOString() } : { completedAt: new Date().toISOString() }), ...(httpStatus !== undefined ? { httpStatus } : {}) });
      await this.writeState(owner, id, registry, current.body.artifact, next, current.index, `context:${status}:${id}`);
    });
    return {
      beforeDispatch: () => detachedCompanionExecutionValidation(() => this.readInJournal(owner, async () => {
        if (complete || dispatched || input.frame.revocationEpoch !== await this.options.currentRevocationEpoch(owner)) throw new Error('发送前来源已撤销，禁止重发旧上下文。');
        const current = await this.admittedIndex(owner, await this.options.artifacts(owner));
        const state = current.value.entries.find(entry => entry.state.id === id)?.state;
        if (!state || state.status !== 'prepared' || state.bodyHash !== snapshot.bodyHash || state.purpose !== snapshot.purpose
          || state.invocationId !== snapshot.frame.invocationId || state.revocationEpoch !== snapshot.frame.revocationEpoch)
          throw new Error('发送前上下文已退役或发送状态变化，禁止重发。');
      }, input.signal)),
      dispatched: () => detachedCompanionExecutionValidation(async () => { if (complete || dispatched) throw new Error('上下文发送凭证不能重复或倒退。'); await update('dispatched'); dispatched = true; }),
      complete: (outcome, httpStatus) => detachedCompanionExecutionValidation(async () => { if (complete) return; if (outcome === 'cancelled_before_send' && dispatched) throw new Error('已交给网络层的请求不能冒充发送前取消。'); await update(outcome, httpStatus); complete = true; }),
    };
  }
  private async prune(owner: string, registry: CompanionArtifactRegistry, reserve = 0, admitted?: AdmittedIndex): Promise<{ index: AdmittedIndex; completedRetirements: string[] }> {
    const index = admitted ?? await this.admittedIndex(owner, registry), ids = [...index.value.ids]; let changed = false;
    const completedRetirements: string[] = [];
    // Never prune in-flight work to satisfy a count. Provider admission bounds
    // concurrency; a crash-prepared record remains explicitly unconfirmed.
    let retained = ids.length;
    for (const id of [...ids].reverse()) {
      if (retained <= this.retentionLimit - reserve) break;
      const snapshot = index.value.entries.find(entry => entry.state.id === id)!.state;
      if (snapshot.status === 'prepared' || snapshot.status === 'dispatched') continue;
      if (await this.retire(owner, id, registry, true, true)) completedRetirements.push(id);
      retained--; changed = true;
    }
    if (retained > this.retentionLimit - reserve) throw new Error('上下文保留区被未结算请求占用，需先恢复或撤回这些请求；未发送新的请求。');
    // An actual retirement wrote a new index. Otherwise the readonly scan's
    // fresh baseline remains exact; publish checks its SQL revision and bytes.
    return { index: changed ? await this.admittedIndex(owner, registry) : index, completedRetirements };
  }
  async revoke(owner: string, id: string): Promise<void> { await this.serial(owner, async () => this.retire(owner, id, await this.options.artifacts(owner))); }
  async redactOwner(owner: string): Promise<void> {
    await this.serial(owner, async () => {
      const expected = this.options.ownerDirectory?.(owner);
      if (expected) {
        if (!path.isAbsolute(expected) || path.basename(expected) !== owner) throw new Error('伙伴清理命名空间不明确。');
        const parent = await lstat(path.dirname(expected)); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('伙伴清理根目录不可核实。');
        try { const current = await lstat(expected); if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('伙伴清理命名空间被链接替换。'); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT' && path.resolve(String((cause as NodeJS.ErrnoException).path)) === path.resolve(expected)) return; throw cause; }
      }
      const registry = await this.options.artifacts(owner);
      await this.recoverPending(owner, registry, true);
      // Only formal snapshot records are touched, never arbitrary owner files.
      // Owner retirement is fenced against all new publication. The index
      // contains only opaque IDs and is removed with the owner namespace;
      // no new index revision may be created while clearing private bodies.
      for (const id of (await this.index(owner, registry)).value.ids) await this.retire(owner, id, registry, false);
    });
  }
  /** Privacy changes invalidate older epochs, never current in-flight work. */
  async redactStale(owner: string): Promise<void> {
    await this.serial(owner, async () => {
      const registry = await this.options.artifacts(owner), epoch = await this.options.currentRevocationEpoch(owner);
      let afterOperationId: string | undefined, currentPending = false;
      let previousIndex: CompanionRegistryPublication['items'][number] | undefined;
      for (;;) {
        const publications = await registry.pendingPublications({ operationPrefix: 'context:', includeRevoked: true, afterOperationId, limit: 16 }); if (!publications.length) break;
        for (const publication of publications) {
          this.managed(publication, owner); afterOperationId = publication.operationId;
          const captured = await this.publicationEpoch(owner, registry, publication);
          if (captured !== undefined && captured === epoch) { currentPending = true; previousIndex = publication.items.find(item => item.next.artifactId === 'context-index:recent' && item.previousStage) ?? previousIndex; continue; }
          if (publication.items.every(item => item.next.kind === 'runtime_index')) { if (publication.state !== 'revoked') await registry.recover(publication.operationId); else await this.discard(registry, publication); }
          else await this.discard(registry, publication, true);
        }
      }
      afterOperationId = undefined;
      for (;;) {
        const publications = await registry.pendingPublications({ operationPrefix: 'context:', uncleanedOnly: true, afterOperationId, limit: 16 }); if (!publications.length) break;
        for (const publication of publications) { this.managed(publication, owner); afterOperationId = publication.operationId; if (await this.publicationEpoch(owner, registry, publication) !== epoch) await registry.purgePublicationStages(publication.operationId); }
      }
      let active: z.infer<typeof indexSchema>;
      try { active = (await this.index(owner, registry)).value; }
      catch (cause) { if (!currentPending || !previousIndex?.previousStage || !previousIndex.previous) throw cause; active = indexSchema.parse(JSON.parse(await this.staged(registry, previousIndex.previousStage, previousIndex.previous.contentHash))); if (active.companionId !== owner) throw new Error('上下文索引恢复归属不一致。', { cause }); }
      for (const id of active.ids) {
        const artifact = await registry.get(this.ids(id).state, true);
        if (!artifact) { await this.retire(owner, id, registry, !currentPending); continue; }
        const metadata = stateSchema.parse(JSON.parse(await this.staged(registry, artifact.relativePath, artifact.contentHash)));
        if (metadata.revocationEpoch !== epoch) await this.retire(owner, id, registry, !currentPending);
      }
    });
  }
  private async staged(registry: CompanionArtifactRegistry, relative: string, expectedHash: string): Promise<string> {
    if (!/^\.运行\/发布\/暂存\/[a-f0-9-]+\.(?:bin|previous)$/u.test(relative) && !/^\.运行\/上下文\/ctx_[a-f0-9]{32}\/(?:request|attempt)\.json$/u.test(relative)) throw new Error('上下文恢复精确位置无效。');
    const target = path.resolve(registry.root, ...relative.split('/'));
    if (await realpath(registry.root) !== registry.root || await realpath(path.dirname(target)) !== path.dirname(target)) throw new Error('上下文恢复目录被链接替换。');
    const before = await lstat(target); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16 * 1024 * 1024) throw new Error('上下文暂存正文不是合法有界文件。');
    const bytes = await readFile(target), after = await lstat(target);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || hash(bytes) !== expectedHash) throw new Error('上下文暂存正文发生变化。');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  private async publicationEpoch(owner: string, registry: CompanionArtifactRegistry, publication: CompanionRegistryPublication): Promise<number | undefined> {
    const item = publication.items.find(value => /^context:ctx_/u.test(value.next.artifactId)) ?? publication.items.find(value => /^context-state:ctx_/u.test(value.next.artifactId)); if (!item) return undefined;
    let text: string | undefined;
    for (const [index, candidate] of [{ relativePath: item.stage, contentHash: item.next.contentHash }, { relativePath: item.next.relativePath, contentHash: item.next.contentHash }].entries()) {
      try { text = await this.staged(registry, candidate.relativePath, candidate.contentHash); break; } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (index === 0) throw cause;
        // A pending state may leave its still-current predecessor in place.
        const previous = await registry.get(item.next.artifactId, true); if (!previous) throw cause;
        text = await this.staged(registry, previous.relativePath, previous.contentHash); break;
      } }
    }
    if (text === undefined) return undefined;
    if (/^context:ctx_/u.test(item.next.artifactId)) { const snapshot = companionContextSnapshotSchema.parse(JSON.parse(text)); if (snapshot.companionId !== owner || snapshot.frame.companionId !== owner || snapshot.frame.revocationEpoch === undefined) throw new Error('上下文恢复归属或来源撤销版本未核实。'); return snapshot.frame.revocationEpoch; }
    const state = stateSchema.parse(JSON.parse(text)); if (state.companionId !== owner) throw new Error('上下文状态恢复归属不一致。'); return state.revocationEpoch;
  }
  private managed(publication: CompanionRegistryPublication, owner: string) {
    if (publication.ownerId !== owner || !publication.operationId.startsWith('context:') || publication.items.some(item => item.next.producer.kind !== 'host' || !['provider-transport', 'provider-transport-index'].includes(item.next.producer.id)
      || !['context_snapshot', 'runtime_index'].includes(item.next.kind) || !(item.next.relativePath === '.运行/索引/上下文.json' || /^\.运行\/上下文\/ctx_[a-f0-9]{32}\/(?:request|attempt)\.json$/u.test(item.next.relativePath)))) throw new Error('发布不属于受管上下文恢复通道。');
  }
  private async discard(registry: CompanionArtifactRegistry, publication: CompanionRegistryPublication, revokeCurrent = false) {
    if (revokeCurrent) for (const item of publication.items) if (item.next.kind === 'context_snapshot' && await registry.get(item.next.artifactId)) await registry.revoke(item.next.artifactId);
    if (['prepared', 'validated', 'file_published'].includes(publication.state)) await registry.cancelPublication(publication.operationId);
    await registry.discardPublishedFiles(publication.operationId); await registry.purgePublicationStages(publication.operationId);
  }
  private async recoverPending(owner: string, registry: CompanionArtifactRegistry, redact: boolean) {
    let afterOperationId: string | undefined, recovered = 0, cancelled = 0;
    do {
      const publications = await registry.pendingPublications({ operationPrefix: 'context:', includeRevoked: true, afterOperationId, limit: 16 });
      if (!publications.length) break;
      for (const publication of publications) {
        this.managed(publication, owner); afterOperationId = publication.operationId;
        if (redact || publication.state === 'revoked') { await this.discard(registry, publication, true); cancelled++; continue; }
        try {
          const request = publication.items.find(item => /^context:ctx_/u.test(item.next.artifactId));
          const state = publication.items.find(item => /^context-state:ctx_/u.test(item.next.artifactId));
          let epoch: number | undefined;
          if (request) { const snapshot = companionContextSnapshotSchema.parse(JSON.parse(await this.staged(registry, request.stage, request.next.contentHash))); if (snapshot.companionId !== owner || snapshot.frame.companionId !== owner || snapshot.frame.revocationEpoch === undefined) throw new Error('恢复快照归属或来源撤销版本未核实。'); epoch = snapshot.frame.revocationEpoch; }
          else if (state) epoch = stateSchema.parse(JSON.parse(await this.staged(registry, state.stage, state.next.contentHash))).revocationEpoch;
          if (epoch !== undefined && epoch !== await this.options.currentRevocationEpoch(owner)) { await this.discard(registry, publication, true); cancelled++; continue; }
          await registry.recover(publication.operationId, async () => { if (epoch !== undefined && epoch !== await this.options.currentRevocationEpoch(owner)) throw new Error('恢复过程中来源已撤回。'); }); recovered++;
        } catch (cause) {
          const current = await registry.publication(publication.operationId);
          if (current && ['prepared', 'validated', 'file_published', 'revoked', 'cancelled'].includes(current.state)) { await this.discard(registry, current); cancelled++; }
          else throw cause;
        }
      }
    } while (afterOperationId);
    // Completed publications can still have an uncleaned exact staging file
    // after a crash. Do not let unrelated older jobs occupy a first-page gate.
    afterOperationId = undefined;
    do {
      const publications = await registry.pendingPublications({ operationPrefix: 'context:', uncleanedOnly: true, afterOperationId, limit: 16 });
      if (!publications.length) break;
      for (const publication of publications) { this.managed(publication, owner); afterOperationId = publication.operationId; await registry.purgePublicationStages(publication.operationId); }
    } while (afterOperationId);
    return { recovered, cancelled };
  }
  async recoverOwner(owner: string): Promise<{ recovered: number; cancelled: number; unknown: number }> {
    return this.serial(owner, async () => {
      const registry = await this.options.artifacts(owner), result = await this.recoverPending(owner, registry, false);
      await this.finishRetirements(owner, registry);
      const index = await this.index(owner, registry); let unknown = 0;
      for (const id of index.value.ids) {
        const stateId = this.ids(id).state, registered = await registry.get(stateId); if (!registered) { await this.retire(owner, id, registry); continue; }
        const indexed = index.value.schema === 'worldlinebox.companion-context-index-v3' ? index.value.entries.find(entry => entry.state.id === id) : undefined;
        if (indexed && indexed.state.revocationEpoch !== await this.options.currentRevocationEpoch(owner)) { await this.retire(owner, id, registry); continue; }
        const state = stateSchema.parse(JSON.parse((await registry.read({ artifactId: stateId, consumer: 'audit' })).text));
        if (state.revocationEpoch !== await this.options.currentRevocationEpoch(owner)) { await this.retire(owner, id, registry); continue; }
        if (state.status !== 'prepared' && state.status !== 'dispatched') continue;
        const current = await this.admittedIndex(owner, registry);
        if (indexed && JSON.stringify(state) !== JSON.stringify(indexed.state)) throw new Error('恢复状态与正式生命周期摘要不一致。');
        await this.writeState(owner, id, registry, registered, stateSchema.parse({ ...state, status: 'unknown', completedAt: new Date().toISOString() }), current, `context:unknown:${id}`); unknown++;
      }
      return { ...result, unknown };
    });
  }
  private async finishRetirements(owner: string, registry: CompanionArtifactRegistry): Promise<IndexRead> {
    const index = await this.index(owner, registry);
    if (index.value.schema === 'worldlinebox.companion-context-index-v3' && index.value.retiring.length) {
      for (const id of index.value.retiring) await this.retire(owner, id, registry);
      return this.index(owner, registry);
    }
    return index;
  }
  private async retire(owner: string, id: string, registry: CompanionArtifactRegistry, updateIndex = true, completeWithPrepare = false): Promise<boolean> {
    let retirement: AdmittedIndex | undefined;
    if (updateIndex) {
      const index = await this.index(owner, registry);
      if (index.value.schema === 'worldlinebox.companion-context-index-v3') {
        retirement = { ...index, value: index.value };
        if (index.value.ids.includes(id)) {
          const value = lifecycleIndexSchema.parse({ ...index.value, ids: index.value.ids.filter(value => value !== id),
            entries: index.value.entries.filter(entry => entry.state.id !== id), retiring: [...index.value.retiring, id], retiredCount: index.value.retiredCount + 1 });
          // The durable tombstone denies reads before exact file cleanup.
          // A crash leaves bounded work, never an orphaned readable body.
          await registry.publish({ ...this.indexItem({ artifact: index.artifact, value }), operationId: `context:index:retiring:${id}:${randomUUID().replaceAll('-', '')}` });
        } else if (!index.value.retiring.includes(id)) return false;
      }
    }
    const ids = this.ids(id), operations = [`context:prepare:${id}`, ...['dispatched', 'response', 'network_error', 'cancelled_before_send', 'unknown'].map(status => `context:${status}:${id}`)];
    if (await registry.get(ids.body)) await registry.revoke(ids.body);
    for (const artifactId of [ids.body, ids.state]) {
      const artifact = await registry.get(artifactId, true);
      if (artifact) { if (artifact.kind !== 'context_snapshot' || artifact.ownerId !== owner || !artifact.relativePath.startsWith(ids.base + '/')) throw new Error('上下文退役目标越界。'); await registry.purgeRevokedBody(artifactId); }
    }
    for (const operation of operations) {
      const receipt = await registry.publication(operation);
      if (!receipt) continue; this.managed(receipt, owner);
      if (['prepared', 'validated', 'file_published', 'revoked', 'cancelled'].includes(receipt.state)) await this.discard(registry, receipt);
      else await registry.purgePublicationStages(operation);
    }
    if (!updateIndex) return false;
    // Only the caller's mandatory next prepare batch can consume this exact
    // completed cleanup. Cancellation/failure leaves the durable tombstone for
    // ordinary recovery; no new attempt or paid send is invented here.
    if (completeWithPrepare && retirement) return true;
    const index = await this.index(owner, registry);
    if (retirement && index.value.schema === 'worldlinebox.companion-context-index-v3') {
      await registry.publish({ ...this.indexItem({ artifact: index.artifact, value: { ...index.value, retiring: index.value.retiring.filter(value => value !== id) } }),
        operationId: `context:index:retire:${id}:${randomUUID().replaceAll('-', '')}` });
    } else if (index.value.schema === 'worldlinebox.companion-context-index-v2' && index.value.ids.includes(id))
      await registry.publish({ artifactId: 'context-index:recent', kind: 'runtime_index', producer: { kind: 'host', id: 'provider-transport-index' }, relativePath: '.运行/索引/上下文.json', expectedRevision: index.artifact?.contentRevision ?? null,
        content: JSON.stringify(legacyIndexSchema.parse({ ...index.value, ids: index.value.ids.filter(value => value !== id), retiredCount: index.value.retiredCount + 1 })), sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['host'], retentionClass: 'runtime', operationId: `context:index:retire:${id}:${randomUUID().replaceAll('-', '')}` });
    return false;
  }
}
