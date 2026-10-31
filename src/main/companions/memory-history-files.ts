import { createHash } from 'node:crypto';
import type { CompanionMemory } from '../../shared/companions';
import { companionMemorySchema } from '../../shared/companion-memory';
import { companionMemoryHistoryPath, renderCompanionMemoryHistory, type CompanionMemoryHistoryDescriptor, type CompanionMemoryHistoryOutbox, type CompanionMemoryHistoryPayload } from '../../shared/companion-memory-history';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { companionMemoryRegisteredPath, memoryArtifactReference, type CompanionMemoryLibrary, type MemoryLibraryDocumentSession } from './memory-library';
import { companionMemorySourceArtifactId } from './memory-source-files';
import { cancelRetiredMemoryPublications, removeRetiredMemoryFile } from './memory-retired-files';
import { memoryFilePublicationOperation, prepareMemoryFilePublication, releaseHeldMemoryFilePublications } from './memory-publication-jobs';
import { CompanionPublicationBusyError } from './artifact-registry';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
export type CompanionMemoryHistoryTraversal = { active: Set<string>; seen: Set<string>; memo: Map<string, CompanionMemory>;
  sourceChecks?: Map<string, Promise<void>> };
class HistoryInputsPending extends Error {}
class StaleHistoryDelivery extends Error {}
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
export const companionMemoryHistoryArtifactId = (id: string, revision: number) => `history:${id}:r${revision}`;

/** Immutable bodies are typed audit evidence, outside all recall/learning channels.
 * A delivered history file is never reconstructed from the SQL body after loss. */
export class CompanionMemoryHistoryFiles {
  private readonly failedOwners = new Map<string, number>();
  constructor(private readonly options: { library: CompanionMemoryLibrary; report?(error: unknown): void; afterPublish?(job: CompanionMemoryHistoryOutbox): Promise<void> }) {}
  private async check(session: MemoryLibraryDocumentSession, job: CompanionMemoryHistoryOutbox) {
    if (!(await session.request({ type: 'memory.history.outbox.check', id: job.id, leaseToken: job.leaseToken })).memoryHistoryOutboxAccepted) throw new StaleHistoryDelivery('历史发布租约或真实来源授权已撤回。');
  }
  private async publish(session: MemoryLibraryDocumentSession, job: CompanionMemoryHistoryOutbox): Promise<void> {
    const payload = job.payload as CompanionMemoryHistoryPayload | undefined;
    if (!payload || payload.memory.companionId !== session.owner.id || payload.memory.id !== job.memoryId || payload.memory.contentRevision !== job.contentRevision
      || job.relativePath !== companionMemoryHistoryPath(job.memoryId, job.contentRevision, job.bodyHash)) throw new Error('历史发布身份、类型或不可变正文不一致。');
    companionMemorySchema.parse(payload.memory);
    const memory = payload.memory, content = renderCompanionMemoryHistory(payload, job.bodyHash);
    if (hash(content) !== job.documentHash) throw new Error('历史发布正文校验不一致。');
    await this.check(session, job);
    const artifactId = companionMemoryHistoryArtifactId(job.memoryId, job.contentRevision), previous = await session.registry.get(artifactId);
    if (previous) {
      const result = await session.registry.read({ artifactId, consumer: 'audit' });
      if (result.artifact.kind !== 'revision_history' || result.artifact.relativePath !== job.relativePath || result.text !== content) throw new Error('已提交历史被改写或缺失，不能覆盖或SQL重建。');
      await this.check(session, job); return;
    }
    const sourceArtifacts = await session.registry.getMany(memory.sources.map(source => companionMemorySourceArtifactId(source.messageId, source.revision)));
    const sourceRefs = memory.sources.map(source => {
      const artifact = sourceArtifacts.find(item => item.artifactId === companionMemorySourceArtifactId(source.messageId, source.revision));
      if (!artifact) throw new HistoryInputsPending('历史记忆的准确真实来源尚未登记，等待上游原始资料发布。');
      if (artifact.kind !== 'source_evidence' || artifact.contentHash !== source.checksum) throw new Error('历史记忆的真实来源登记身份或原文校验不一致。'); return memoryArtifactReference(artifact);
    });
    const dependencies = await session.registry.getMany(payload.dependencies.map(dependency => companionMemoryHistoryArtifactId(dependency.id, dependency.contentRevision)));
    const dependencyRefs = payload.dependencies.map(dependency => {
      const artifact = dependencies.find(item => item.artifactId === companionMemoryHistoryArtifactId(dependency.id, dependency.contentRevision));
      if (!artifact) throw new HistoryInputsPending('历史记忆的准确依赖版本尚未登记，等待上游版本发布。');
      if (artifact.kind !== 'revision_history') throw new Error('历史记忆依赖版本的登记类型不一致。'); return memoryArtifactReference(artifact);
    });
    const operationId = memoryFilePublicationOperation('history', job.id, job.retryCycle);
    await prepareMemoryFilePublication(session, operationId, this.options.report);
    await session.registry.publish({ artifactId, kind: 'revision_history', producer: { kind: 'host', id: 'history-outbox' },
      relativePath: job.relativePath, expectedRevision: null, content, sourceRefs, dependencyRefs, visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'history',
      operationId }, async () => {
        await this.check(session, job); for (const reference of sourceRefs) await session.registry.read({ artifactId: reference.artifactId, consumer: 'source_verification', audienceIds: [memory.sourceConversationId] });
      }, { kind: 'history_files', id: job.id, leaseToken: job.leaseToken, retryCycle: job.retryCycle });
    await this.options.afterPublish?.(job);
  }
  private async withdraw(session: MemoryLibraryDocumentSession, job: CompanionMemoryHistoryOutbox) {
    const artifactId = companionMemoryHistoryArtifactId(job.memoryId, job.contentRevision);
    const artifact = await session.registry.get(artifactId, true);
    if (artifact) { await session.registry.revoke(artifactId); await removeRetiredMemoryFile(session.registry, artifact); }
    await cancelRetiredMemoryPublications(session.registry, artifactId, 'history-outbox', 'revision_history');
  }
  private async deliver(session: MemoryLibraryDocumentSession, limit: number, target?: { id?: string; contentRevision?: number; operation?: 'publish' | 'retract'; throughOrdinal?: number }): Promise<{ completed: number; pending: boolean; failed: number; waiting: number }> {
    let completed = 0, processed = 0, failed = 0, waiting = 0;
    for (; processed < limit; processed++) {
      const job = (await session.request({ type: 'memory.history.outbox.claim', companionId: session.owner.id, ...(target ? { memoryId: target.id, contentRevision: target.contentRevision,
        operation: target.operation, throughOrdinal: target.throughOrdinal } : {}) })).memoryHistoryOutbox;
      if (!job) break;
      if (job.companionId !== session.owner.id) throw new Error('历史发布不属于当前伙伴。');
      try {
        if (job.operation === 'retract') await this.withdraw(session, job);
        else {
          await this.publish(session, job);
          // One durable outbox owns both the immutable revision and current
          // body. A crash between them leaves this job unacknowledged; replay
          // verifies the history and completes only its still-current body.
          const current = (await session.request({ type: 'memory.library.read', companionId: session.owner.id, id: job.memoryId })).memoryRead?.memory;
          if (current && current.contentRevision === job.contentRevision) {
            const payload = job.payload as CompanionMemoryHistoryPayload | undefined;
            if (!payload || current.content !== payload.memory.content || current.artifactKind !== payload.memory.artifactKind) throw new Error('历史发布与当前正式正文不一致。');
            await this.check(session, job);
            await session.project(companionMemoryRegisteredPath(current), current, { dependencies: payload.dependencies, jobId: job.id, retryCycle: job.retryCycle,
              check: () => this.check(session, job), fileJobGuard: { kind: 'history_files', id: job.id, leaseToken: job.leaseToken, retryCycle: job.retryCycle } });
            await this.check(session, job);
          }
        }
        const result = await session.request({ type: 'memory.history.outbox.complete', id: job.id, leaseToken: job.leaseToken, documentHash: job.documentHash });
        if (!result.memoryHistoryOutboxAccepted) await this.withdraw(session, job);
        if (result.memoryHistoryOutboxAccepted) completed++;
      } catch (cause) {
        const current = await session.request({ type: 'memory.history.outbox.check', id: job.id, leaseToken: job.leaseToken });
        const failureKind = cause instanceof StaleHistoryDelivery || current.memoryHistoryOutboxAccepted === false ? 'stale' : cause instanceof HistoryInputsPending || cause instanceof CompanionPublicationBusyError ? 'waiting' : 'processing';
        // A failed/parked publisher never grants file deletion. A real source
        // withdrawal has its own durable retract row, consumed independently.
        const recorded = await session.request({ type: 'memory.history.outbox.fail', id: job.id, leaseToken: job.leaseToken, failureKind,
          error: cause instanceof Error ? cause.message.slice(0, 1000) : '历史发布失败。', retryAfterMs: 30_000 });
        if (!recorded.ok) throw new Error(recorded.error || '历史发布失败处置尚未耐久保存。', { cause });
        await releaseHeldMemoryFilePublications(session, this.options.report);
        if (failureKind === 'processing') { failed++; this.options.report?.(cause); } else waiting++;
      }
    }
    return { completed, pending: processed === limit, failed, waiting };
  }
  flush(owner: string, input: { limit?: number; memoryId?: string; contentRevision?: number; operation?: 'publish' | 'retract'; throughOrdinal?: number; ifIdle?: boolean } = {}): Promise<{ completed: number; pending: boolean; failed: number; waiting: number }> {
    return this.options.library.withDocuments(owner, session => this.deliver(session, Math.max(1, Math.min(256, input.limit ?? 64)), {
      id: input.memoryId, contentRevision: input.contentRevision, operation: input.operation, throughOrdinal: input.throughOrdinal }), { sourceDelivery: true, ifIdle: input.ifIdle });
  }
  async flushPending(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, limitOwners = 4): Promise<void> {
    for (const [owner, until] of this.failedOwners) if (until <= Date.now()) this.failedOwners.delete(owner);
    const result = await request({ type: 'memory.history.outbox.owners', limit: limitOwners, excludedOwners: [...this.failedOwners.keys()].slice(-128) });
    if (!result.ok) throw new Error(result.error || '历史发布队列不可用。');
    for (const owner of result.memoryHistoryPendingOwners ?? []) try { await this.flush(owner); } catch (cause) { this.failedOwners.set(owner, Date.now() + 30_000); this.options.report?.(cause); }
  }
  read(scope: Scope, id: string, contentRevision: number, traversal?: CompanionMemoryHistoryTraversal): Promise<CompanionMemory> {
    return this.options.library.withDocuments(scope.companionId, session => this.readInSession(session, scope, id, contentRevision, traversal), { readOnly: true, sourceDelivery: true });
  }
  readMany(scope: Scope, roots: readonly { id: string; contentRevision: number }[]): Promise<CompanionMemory[]> {
    if (!roots.length) return Promise.resolve([]);
    return this.options.library.withDocuments(scope.companionId, session => this.readManyInSession(session, scope, roots), { readOnly: true, sourceDelivery: true });
  }
  private decode(scope: Scope, before: CompanionMemoryHistoryDescriptor,
    registered: Awaited<ReturnType<MemoryLibraryDocumentSession['registry']['read']>>): CompanionMemory {
    const { id, contentRevision } = before;
    if (before.companionId !== scope.companionId || before.relativePath !== companionMemoryHistoryPath(id, contentRevision, before.bodyHash)) throw new Error('历史描述归属不一致。');
    if (registered.artifact.kind !== 'revision_history' || registered.artifact.relativePath !== before.relativePath || registered.artifact.contentHash !== before.documentHash) throw new Error('历史登记与正式修订不一致。');
    const match = /^---\n([^]*?)\n---\n([^]*)$/u.exec(registered.text); if (!match) throw new Error('历史正文封装无效。');
    const header = JSON.parse(match[1]!) as { schema: string; companionId: string; id: string; contentRevision: number; bodyHash: string; memory: object; dependencies: unknown };
    if (header.schema !== 'worldlinebox.companion-memory-history-v2' || header.companionId !== scope.companionId || header.id !== id
      || header.contentRevision !== contentRevision || header.bodyHash !== before.bodyHash || JSON.stringify(header.dependencies) !== JSON.stringify(before.dependencies)) throw new Error('历史封装与正式来源凭证不一致。');
    const memory = companionMemorySchema.parse({ ...header.memory, content: match[2]! });
    if (memory.id !== id || memory.companionId !== scope.companionId || memory.contentRevision !== contentRevision) throw new Error('历史正文身份不一致。');
    return memory;
  }
  /** A whole canonical closure crosses IPC twice, rather than once per node.
   * Bodies remain exclusively in registered files; SQL supplies only current
   * authorized descriptors and never a replacement body. */
  async readManyInSession(session: MemoryLibraryDocumentSession, scope: Scope, roots: readonly { id: string; contentRevision: number }[]): Promise<CompanionMemory[]> {
    if (!roots.length) return [];
    if (session.owner.id !== scope.companionId || roots.length > 10000) throw new Error('历史依赖归属或预算无效。');
    const key = (reference: { id: string; contentRevision: number }) => `${reference.id}:${reference.contentRevision}`;
    const describe = async () => {
      const response = await session.request({ type: 'memory.revisions.describe', ...scope, roots: [...roots] });
      if (!response.ok || !response.memoryHistoryDescriptors) throw new Error('历史修订依赖暂不可完整读取。');
      const result = new Map(response.memoryHistoryDescriptors.map(value => [key(value), value]));
      if (result.size !== response.memoryHistoryDescriptors.length) throw new Error('历史修订闭包包含重复身份。');
      return result;
    };
    const before = await describe(), active = new Set<string>(), complete = new Set<string>();
    const pending = roots.map(reference => ({ key: key(reference), closing: false }));
    while (pending.length) {
      const entry = pending.pop()!;
      if (entry.closing) { active.delete(entry.key); complete.add(entry.key); continue; }
      if (complete.has(entry.key)) continue;
      const descriptor = before.get(entry.key);
      if (!descriptor || active.has(entry.key)) throw new Error('历史依赖闭包缺失或存在环路。');
      active.add(entry.key); pending.push({ ...entry, closing: true });
      for (const dependency of descriptor.dependencies) pending.push({ key: key(dependency), closing: false });
    }
    if (complete.size !== before.size) throw new Error('历史闭包包含未请求的修订。');
    const descriptors = [...before.values()];
    const bodies = await session.registry.readMany(descriptors.map(reference => ({ artifactId: companionMemoryHistoryArtifactId(reference.id, reference.contentRevision), consumer: 'audit' as const })));
    const memories = new Map(descriptors.map((reference, index) => [key(reference), this.decode(scope, reference, bodies[index]!)]));
    const sources = [...new Map([...memories.values()].flatMap(memory => memory.sources)
      .map(source => [JSON.stringify([source.messageId, source.revision, source.checksum]), source])).values()];
    const originals = await session.registry.readMany(sources.map(source => ({ artifactId: companionMemorySourceArtifactId(source.messageId, source.revision),
      consumer: 'source_verification' as const, audienceIds: [scope.conversationId] })));
    for (let index = 0; index < sources.length; index++) if (originals[index]?.artifact.kind !== 'source_evidence'
      || originals[index]!.artifact.contentHash !== sources[index]!.checksum) throw new Error('历史真实来源已变化或缺失。');
    const after = await describe();
    if (after.size !== before.size) throw new Error('读取期间历史闭包已变化。');
    for (const [identity, expected] of before) {
      const actual = after.get(identity);
      if (!actual || actual.bodyHash !== expected.bodyHash || actual.documentHash !== expected.documentHash || actual.relativePath !== expected.relativePath
        || JSON.stringify(actual.sources) !== JSON.stringify(expected.sources) || JSON.stringify(actual.dependencies) !== JSON.stringify(expected.dependencies)) throw new Error('读取期间历史授权已变化。');
      const memory = memories.get(identity)!;
      if (memory.procedure && actual.procedureValidation) memory.procedure.validation = actual.procedureValidation;
    }
    return roots.map(reference => memories.get(key(reference))!);
  }
  async readInSession(session: MemoryLibraryDocumentSession, scope: Scope, id: string, contentRevision: number, traversal: CompanionMemoryHistoryTraversal = { active: new Set(), seen: new Set(), memo: new Map() }): Promise<CompanionMemory> {
    const key = `${id}:${contentRevision}`, remembered = traversal.memo.get(key); if (remembered) return remembered;
    if (session.owner.id !== scope.companionId || traversal.active.has(key) || !traversal.seen.has(key) && traversal.seen.size >= 10_000) throw new Error('历史依赖归属、环路或闭包预算无效。');
    traversal.seen.add(key); traversal.active.add(key);
    try {
      const describe = async () => {
        const result = await session.request({ type: 'memory.revision.describe', companionId: scope.companionId, conversationId: scope.conversationId, ...(scope.beforeSequence === undefined ? {} : { beforeSequence: scope.beforeSequence }), id, contentRevision });
        if (!result.memoryHistoryDescriptor) throw new Error('历史修订未正式发布或当前入口无权读取。'); return result.memoryHistoryDescriptor;
      };
      const before = await describe();
      if (before.id !== id || before.contentRevision !== contentRevision) throw new Error('历史描述归属不一致。');
      const registered = await session.registry.read({ artifactId: companionMemoryHistoryArtifactId(id, contentRevision), consumer: 'audit' });
      const memory = this.decode(scope, before, registered);
      for (const dependency of before.dependencies) await this.readInSession(session, scope, dependency.id, dependency.contentRevision, traversal);
      const sourceChecks = traversal.sourceChecks ??= new Map<string, Promise<void>>();
      const missing = new Map<string, typeof memory.sources[number]>(), waiting = new Set<Promise<void>>();
      for (const source of memory.sources) {
        const sourceKey = JSON.stringify([scope.companionId, scope.conversationId, source.messageId, source.revision, source.checksum]);
        const pending = sourceChecks.get(sourceKey);
        if (pending) waiting.add(pending); else missing.set(sourceKey, source);
      }
      if (missing.size) {
        const expected = [...missing.values()];
        const batch = session.registry.readMany(expected.map(source => ({ artifactId: companionMemorySourceArtifactId(source.messageId, source.revision),
          consumer: 'source_verification' as const, audienceIds: [scope.conversationId] }))).then(references => {
          for (let index = 0; index < expected.length; index++) if (references[index]?.artifact.kind !== 'source_evidence'
            || references[index]!.artifact.contentHash !== expected[index]!.checksum) throw new Error('历史真实来源已变化或缺失。');
        });
        for (const sourceKey of missing.keys()) sourceChecks.set(sourceKey, batch);
        waiting.add(batch);
      }
      await Promise.all(waiting);
      const after = await describe();
      if (after.documentHash !== before.documentHash || after.bodyHash !== before.bodyHash) throw new Error('读取期间历史授权已变化。');
      if (memory.procedure && after.procedureValidation) memory.procedure.validation = after.procedureValidation;
      traversal.memo.set(key, memory); return memory;
    } finally { traversal.active.delete(key); }
  }
}
