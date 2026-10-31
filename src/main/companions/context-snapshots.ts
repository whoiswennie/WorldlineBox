import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { companionContextSnapshotSchema, companionContextSnapshotSummarySchema, type CompanionContextSnapshot } from '../../shared/companion-cognition';
import type { CompanionArtifact, CompanionArtifactReference } from '../../shared/companion-artifact';
import type { CompanionArtifactRegistry } from './artifact-registry';
import type { CompanionTransportAttempt, CompanionTransportAttemptInput } from './model';
import type { CompanionRegistryPublication } from '../../shared/companion-registry-storage';
import { detachedCompanionExecutionValidation, withCompanionExecutionValidation } from './source-execution-evidence';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const snapshotId = z.string().regex(/^ctx_[a-f0-9]{32}$/u);
const indexSchema = z.strictObject({ schema: z.literal('worldlinebox.companion-context-index-v2'), companionId: z.string(), ids: z.array(snapshotId).max(40), retiredCount: z.number().int().nonnegative() });
const stateSchema = companionContextSnapshotSummarySchema.extend({ revocationEpoch: z.number().int().nonnegative() });
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
  private ids(id: string) { snapshotId.parse(id); return { body: `context:${id}`, state: `context-state:${id}`, base: `.运行/上下文/${id}` }; }
  private async index(owner: string, registry: CompanionArtifactRegistry): Promise<{ artifact?: CompanionArtifact; value: z.infer<typeof indexSchema> }> {
    const artifact = await registry.get('context-index:recent');
    if (!artifact) return { value: { schema: 'worldlinebox.companion-context-index-v2', companionId: owner, ids: [], retiredCount: 0 } };
    const result = await registry.read({ artifactId: artifact.artifactId, consumer: 'host' }), value = indexSchema.parse(JSON.parse(result.text));
    if (artifact.kind !== 'runtime_index' || value.companionId !== owner) throw new Error('上下文保留索引归属无效。'); return { artifact, value };
  }
  private async load(owner: string, id: string, authorize = true): Promise<CompanionContextSnapshot> {
    const registry = await this.options.artifacts(owner), ids = this.ids(id);
    const body = await registry.read({ artifactId: ids.body, consumer: 'audit' }), state = await registry.read({ artifactId: ids.state, consumer: 'audit' });
    if (body.artifact.kind !== 'context_snapshot' || state.artifact.kind !== 'context_snapshot' || body.artifact.ownerId !== owner || state.artifact.ownerId !== owner) throw new Error('上下文快照归属不一致。');
    const metadata = stateSchema.parse(JSON.parse(state.text));
    const snapshot = companionContextSnapshotSchema.parse({ ...JSON.parse(body.text), status: metadata.status, sentAt: metadata.sentAt, completedAt: metadata.completedAt, httpStatus: metadata.httpStatus });
    if (snapshot.companionId !== owner || snapshot.frame.companionId !== owner || snapshot.id !== id || hash(snapshot.providerBody) !== snapshot.bodyHash) throw new Error('上下文正文、版本或归属校验不一致。');
    if (authorize) { if (metadata.revocationEpoch !== await this.options.currentRevocationEpoch(owner)) throw new Error('本次上下文涉及的来源可能已撤回，正文已停止提供。'); await this.options.validateRead(snapshot); }
    return snapshot;
  }
  async read(owner: string, id: string): Promise<CompanionContextSnapshot> { return this.load(owner, id); }
  async list(owner: string, limit = 20) {
    const registry = await this.options.artifacts(owner), index = await this.index(owner, registry), ids = index.value.ids.slice(0, Math.max(1, Math.min(40, limit)));
    const artifacts = await registry.getMany(ids.map(id => this.ids(id).state));
    const items: z.infer<typeof companionContextSnapshotSummarySchema>[] = [];
    const epoch = await this.options.currentRevocationEpoch(owner);
    for (const id of ids) {
      const artifact = artifacts.find(item => item.artifactId === this.ids(id).state); if (!artifact) continue;
      const value = stateSchema.parse(JSON.parse((await registry.read({ artifactId: artifact.artifactId, consumer: 'audit' })).text)), { revocationEpoch, ...metadata } = value;
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
      const active = await withCompanionExecutionValidation(async () => {
        const active = await this.index(owner, registry), metadata = await registry.getMany(active.value.ids.map(activeId => this.ids(activeId).state));
        const bodies = await registry.readMany(metadata.map(artifact => ({ artifactId: artifact.artifactId, consumer: 'audit' as const })));
        for (const body of bodies) {
          const state = stateSchema.parse(JSON.parse(body.text));
          if (state.status === 'unknown' && state.purpose === input.frame.purpose && (input.frame.invocationId ? state.invocationId === input.frame.invocationId : state.bodyHash === snapshot.bodyHash)) throw new CompanionUnknownContextAttemptError('这个调用仍有发送或结果未确认的历史凭证，禁止自动重发。');
        }
        return active;
      }, input.signal);
      input.signal?.throwIfAborted();
      const index = await this.prune(owner, registry, 1, active), nextIndex = { ...index.value, ids: [id, ...index.value.ids] };
      const state = stateSchema.parse({ ...summary(snapshot), revocationEpoch: input.frame.revocationEpoch }), content = JSON.stringify(snapshot), bodyHash = hash(content);
      input.signal?.throwIfAborted();
      await registry.publishBatch({ operationId: `context:prepare:${id}`, items: [
        { artifactId: ids.body, kind: 'context_snapshot', producer: { kind: 'host', id: 'provider-transport' }, relativePath: ids.base + '/request.json', expectedRevision: null, content, ...references, visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'ephemeral' },
        { artifactId: ids.state, kind: 'context_snapshot', producer: { kind: 'host', id: 'provider-transport' }, relativePath: ids.base + '/attempt.json', expectedRevision: null, content: JSON.stringify(state), sourceRefs: [], dependencyRefs: [{ artifactId: ids.body, contentRevision: 1, contentHash: bodyHash }], visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'ephemeral' },
        { artifactId: 'context-index:recent', kind: 'runtime_index', producer: { kind: 'host', id: 'provider-transport-index' }, relativePath: '.运行/索引/上下文.json', expectedRevision: index.artifact?.contentRevision ?? null, content: JSON.stringify(indexSchema.parse(nextIndex)), sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['host'], retentionClass: 'runtime' },
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
        return (await registry.readMany([{ artifactId: ids.body, consumer: 'audit' }, { artifactId: ids.state, consumer: 'audit' }]))[1]!;
      });
      if (!current) return;
      const state = stateSchema.parse(JSON.parse(current.text));
      const next = stateSchema.parse({ ...state, status, ...(status === 'dispatched' ? { sentAt: new Date().toISOString() } : { completedAt: new Date().toISOString() }), ...(httpStatus !== undefined ? { httpStatus } : {}) });
      await registry.publish({ artifactId: ids.state, kind: 'context_snapshot', producer: { kind: 'host', id: 'provider-transport' }, relativePath: ids.base + '/attempt.json', expectedRevision: current.artifact.contentRevision, content: JSON.stringify(next), sourceRefs: [], dependencyRefs: current.artifact.dependencyRefs,
        visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'ephemeral', operationId: `context:${status}:${id}` });
    });
    return {
      beforeDispatch: async () => { if (complete || dispatched || input.frame.revocationEpoch !== await this.options.currentRevocationEpoch(owner)) throw new Error('发送前来源已撤销，禁止重发旧上下文。'); },
      dispatched: () => detachedCompanionExecutionValidation(async () => { if (complete || dispatched) throw new Error('上下文发送凭证不能重复或倒退。'); await update('dispatched'); dispatched = true; }),
      complete: (outcome, httpStatus) => detachedCompanionExecutionValidation(async () => { if (complete) return; if (outcome === 'cancelled_before_send' && dispatched) throw new Error('已交给网络层的请求不能冒充发送前取消。'); await update(outcome, httpStatus); complete = true; }),
    };
  }
  private async prune(owner: string, registry: CompanionArtifactRegistry, reserve = 0,
    admitted?: { artifact?: CompanionArtifact; value: z.infer<typeof indexSchema> }) {
    const index = admitted ?? await this.index(owner, registry), ids = [...index.value.ids]; let changed = false;
    // Never prune in-flight work to satisfy a count. Provider admission bounds
    // concurrency; a crash-prepared record remains explicitly unconfirmed.
    let retained = ids.length;
    for (const id of [...ids].reverse()) {
      if (retained <= this.retentionLimit - reserve) break;
      const state = await registry.get(this.ids(id).state);
      if (!state) { await this.retire(owner, id, registry); retained--; changed = true; continue; }
      const snapshot = stateSchema.parse(JSON.parse((await registry.read({ artifactId: state.artifactId, consumer: 'audit' })).text));
      if (snapshot.status === 'prepared' || snapshot.status === 'dispatched') continue;
      await this.retire(owner, id, registry);
      retained--; changed = true;
    }
    if (retained > this.retentionLimit - reserve) throw new Error('上下文保留区被未结算请求占用，需先恢复或撤回这些请求；未发送新的请求。');
    // An actual retirement wrote a new index. Otherwise the readonly scan's
    // fresh baseline remains exact; publish checks its SQL revision and bytes.
    return changed ? this.index(owner, registry) : index;
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
      const registry = await this.options.artifacts(owner), result = await this.recoverPending(owner, registry, false), index = await this.index(owner, registry); let unknown = 0;
      for (const id of index.value.ids) {
        const stateId = this.ids(id).state, registered = await registry.get(stateId); if (!registered) { await this.retire(owner, id, registry); continue; }
        const state = stateSchema.parse(JSON.parse((await registry.read({ artifactId: stateId, consumer: 'audit' })).text));
        if (state.revocationEpoch !== await this.options.currentRevocationEpoch(owner)) { await this.retire(owner, id, registry); continue; }
        if (state.status !== 'prepared' && state.status !== 'dispatched') continue;
        await registry.publish({ artifactId: stateId, kind: 'context_snapshot', producer: { kind: 'host', id: 'provider-transport' }, relativePath: this.ids(id).base + '/attempt.json', expectedRevision: registered.contentRevision,
          content: JSON.stringify(stateSchema.parse({ ...state, status: 'unknown', completedAt: new Date().toISOString() })), sourceRefs: [], dependencyRefs: registered.dependencyRefs, visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'ephemeral', operationId: `context:unknown:${id}` }); unknown++;
      }
      return { ...result, unknown };
    });
  }
  private async retire(owner: string, id: string, registry: CompanionArtifactRegistry, updateIndex = true) {
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
    if (!updateIndex) return;
    const index = await this.index(owner, registry);
    if (index.value.ids.includes(id)) await registry.publish({ artifactId: 'context-index:recent', kind: 'runtime_index', producer: { kind: 'host', id: 'provider-transport-index' }, relativePath: '.运行/索引/上下文.json', expectedRevision: index.artifact?.contentRevision ?? null,
      content: JSON.stringify(indexSchema.parse({ ...index.value, ids: index.value.ids.filter(value => value !== id), retiredCount: index.value.retiredCount + 1 })), sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['host'], retentionClass: 'runtime', operationId: `context:index:retire:${id}:${randomUUID().replaceAll('-', '')}` });
  }
}
