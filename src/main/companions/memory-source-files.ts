import { createHash } from 'node:crypto';
import type { CompanionMemory } from '../../shared/companions';
import type { CompanionMemorySourceOutbox } from '../../shared/companion-memory';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemoryLibrary, MemoryLibraryDocumentSession } from './memory-library';
import { cancelRetiredMemoryPublications, removeRetiredMemoryFile } from './memory-retired-files';
import { companionHostBehaviorMatches } from '../../shared/companion-host-behavior';
import type { CompanionArtifactVisibility } from '../../shared/companion-artifact';
import { memoryFilePublicationOperation, prepareMemoryFilePublication, releaseHeldMemoryFilePublications } from './memory-publication-jobs';
import { CompanionPublicationBusyError } from './artifact-registry';

const checksum = (text: string) => createHash('sha256').update(text).digest('hex');
class StaleSourceDelivery extends Error {}
export const companionMemorySourceArtifactId = (sourceId: string, revision: number) => `source:${sourceId}:r${revision}`;
export function companionMemorySourceFilePath(source: Pick<CompanionMemorySourceOutbox, 'sourceId' | 'sourceRevision' | 'sourceChecksum'>): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(source.sourceId) || !Number.isSafeInteger(source.sourceRevision) || source.sourceRevision < 1 || !/^[a-f0-9]{64}$/u.test(source.sourceChecksum)) throw new Error('来源发布身份无效。');
  return `证据/来源/${source.sourceId}-r${source.sourceRevision}-${source.sourceChecksum.slice(0, 20)}.md`;
}
/** Source copies can only arrive from the host's durable source outbox.
 * Their paths, prose and sidecars never grant a source identity or permission. */
export class CompanionMemorySourceFiles {
  private readonly failedOwners = new Map<string, number>();
  constructor(private readonly options: { library: CompanionMemoryLibrary; report?(error: unknown): void }) {}
  async flushPending(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, options: { limitOwners?: number } = {}): Promise<{ owners: number; completed: number; pending: boolean }> {
    for (const [owner, until] of this.failedOwners) if (until <= Date.now()) this.failedOwners.delete(owner);
    const response = await request({ type: 'memory.sources.outbox.owners', limit: Math.max(1, Math.min(128, options.limitOwners ?? 4)), excludedOwners: [...this.failedOwners.keys()].slice(-128) });
    if (!response.ok) throw new Error(response.error || '来源发布队列暂不可用。');
    let completed = 0, pending = false;
    const owners = response.memorySourcePendingOwners ?? [];
    for (const owner of owners) try { const result = await this.flush(owner); completed += result.completed; pending ||= result.pending; }
      catch (error) { this.failedOwners.set(owner, Date.now() + 30_000); pending = true; this.options.report?.(error); }
    return { owners: owners.length, completed, pending: pending || owners.length >= (options.limitOwners ?? 4) };
  }
  private async withdraw(session: MemoryLibraryDocumentSession, artifactId: string) {
    const artifact = await session.registry.get(artifactId, true);
    if (artifact) { await session.registry.revoke(artifactId); await removeRetiredMemoryFile(session.registry, artifact); }
    await cancelRetiredMemoryPublications(session.registry, artifactId, 'source-outbox', 'source_evidence');
  }
  flush(owner: string, options: { limit?: number; jobId?: string; operation?: 'publish' | 'retract'; throughOrdinal?: number; ifIdle?: boolean } = {}): Promise<{ completed: number; pending: boolean; failed: number; waiting: number }> {
    const limit = Math.max(1, Math.min(256, options.limit ?? 64));
    return this.options.library.withDocuments(owner, async session => {
      let completed = 0, processed = 0, failed = 0, waiting = 0;
      for (; processed < limit; processed++) {
        const job = (await session.request({ type: 'memory.sources.outbox.claim', companionId: owner, ...(options.jobId ? { jobId: options.jobId } : {}),
          ...(options.operation ? { operation: options.operation } : {}), ...(options.throughOrdinal === undefined ? {} : { throughOrdinal: options.throughOrdinal }) })).memorySourceOutbox;
        if (!job) break;
        if (job.companionId !== owner) throw new Error('来源发布归属不一致。');
        const artifactId = companionMemorySourceArtifactId(job.sourceId, job.sourceRevision);
        try {
          if (job.operation === 'retract') await this.withdraw(session, artifactId);
          else {
            const source = job.source;
            if (!source || source.messageId !== job.sourceId || source.revision !== job.sourceRevision || source.checksum !== job.sourceChecksum || checksum(source.content) !== job.sourceChecksum) throw new Error('来源发布凭证与真实原文不一致。');
            let hostPolicyFingerprint: string | undefined, visibility: CompanionArtifactVisibility = { scope: 'owner' };
            const check = async () => {
              if (!(await session.request({ type: 'memory.sources.outbox.check', id: job.id, leaseToken: job.leaseToken })).memorySourceOutboxAccepted)
                throw new StaleSourceDelivery('来源发布的固定输入或作业租约已经失效。');
              const current = (await session.request({ type: 'memory.sources.filter', companionId: owner, conversationId: source.conversationId, ids: [source.messageId] })).memorySources?.find(item => item.id === source.messageId);
              if (!current || current.revision !== source.revision || checksum(current.content) !== source.checksum) throw new StaleSourceDelivery('来源已撤回或原文版本已修订。');
              const receipt = companionHostBehaviorMatches(owner, { ...current, checksum: checksum(current.content) }), fingerprint = JSON.stringify(receipt ?? null);
              if (hostPolicyFingerprint !== undefined && hostPolicyFingerprint !== fingerprint) throw new StaleSourceDelivery('宿主行为或受众凭证已变化。');
              hostPolicyFingerprint = fingerprint; visibility = receipt ? { scope: 'audience', audienceIds: receipt.audienceIds } : { scope: 'owner' };
            };
            await check();
            const previous = await session.registry.get(artifactId);
            if (previous) {
              const registered = await session.registry.read({ artifactId, consumer: 'source_verification', audienceIds: [source.conversationId] });
              if (registered.artifact.kind !== 'source_evidence' || registered.text !== source.content) throw new Error('已登记来源正文不一致；不覆盖或从SQL重建。');
            } else {
              const operationId = memoryFilePublicationOperation('source', job.id, job.retryCycle);
              await prepareMemoryFilePublication(session, operationId, this.options.report);
              await session.registry.publish({ artifactId, kind: 'source_evidence', producer: { kind: 'host', id: 'source-outbox' },
              relativePath: companionMemorySourceFilePath(job), expectedRevision: null, content: source.content, sourceRefs: [], dependencyRefs: [],
              visibility, allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence',
              operationId }, check, { kind: 'source_files', id: job.id, leaseToken: job.leaseToken, retryCycle: job.retryCycle });
            }
          }
          const result = await session.request({ type: 'memory.sources.outbox.complete', id: job.id, leaseToken: job.leaseToken });
          if (job.operation === 'publish' && !result.memorySourceOutboxAccepted) await this.withdraw(session, artifactId);
          if (result.memorySourceOutboxAccepted) completed++;
        } catch (cause) {
          const current = await session.request({ type: 'memory.sources.outbox.check', id: job.id, leaseToken: job.leaseToken });
          const failureKind = cause instanceof StaleSourceDelivery || current.memorySourceOutboxAccepted === false ? 'stale' : cause instanceof CompanionPublicationBusyError ? 'waiting' : 'processing';
          const recorded = await session.request({ type: 'memory.sources.outbox.fail', id: job.id, leaseToken: job.leaseToken, failureKind,
            error: cause instanceof Error ? cause.message.slice(0, 1000) : '来源发布失败。', retryAfterMs: 30_000 });
          if (!recorded.ok) throw new Error(recorded.error || '来源发布的失败处置尚未耐久保存。', { cause });
          await releaseHeldMemoryFilePublications(session, this.options.report);
          if (failureKind === 'processing') { failed++; this.options.report?.(cause); } else waiting++;
        }
      }
      return { completed, pending: processed === limit, failed, waiting };
    }, { sourceDelivery: true, ifIdle: options.ifIdle });
  }
  read(scope: { companionId: string; conversationId: string; beforeSequence?: number }, reference: Pick<CompanionMemory['sources'][number], 'messageId' | 'revision' | 'checksum'>): Promise<string> {
    return this.options.library.withDocuments(scope.companionId, async session => {
      const current = async () => (await session.request({ type: 'memory.sources.filter', companionId: scope.companionId, conversationId: scope.conversationId, ...(scope.beforeSequence === undefined ? {} : { beforeSequence: scope.beforeSequence }), ids: [reference.messageId] })).memorySources?.find(item => item.id === reference.messageId);
      const before = await current(); if (!before || before.revision !== reference.revision || checksum(before.content) !== reference.checksum) throw new Error('来源已撤回、修订或当前范围无权读取。');
      const result = await session.registry.read({ artifactId: companionMemorySourceArtifactId(reference.messageId, reference.revision), consumer: 'source_verification', audienceIds: [scope.conversationId] });
      const after = await current();
      if (result.artifact.kind !== 'source_evidence' || result.artifact.contentHash !== reference.checksum || !after || after.revision !== reference.revision || checksum(after.content) !== reference.checksum) throw new Error('来源文件或授权已变化；不使用SQL正文替代。');
      return result.text;
    }, { readOnly: true, sourceDelivery: true });
  }
}
