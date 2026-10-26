import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { CompanionMemory } from '../../shared/companions';
import type { CompanionMemorySourceOutbox } from '../../shared/companion-memory';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemoryLibrary, MemoryLibraryDocumentSession } from './memory-library';

const checksum = (content: string) => createHash('sha256').update(content).digest('hex');
const relative = (source: { sourceId: string; sourceRevision: number; sourceChecksum: string }) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(source.sourceId) || !Number.isSafeInteger(source.sourceRevision) || source.sourceRevision < 1 || !/^[a-f0-9]{64}$/u.test(source.sourceChecksum)) throw new Error('来源发布身份无效。');
  return `来源/${source.sourceId}-r${source.sourceRevision}-${source.sourceChecksum.slice(0, 20)}.md`;
};
/** Readable owner-local original material. The SQL ledger determines source
 * identity/permission; edited copies can never create messages or new grants. */
export class CompanionMemorySourceFiles {
  private readonly failedOwners = new Map<string, number>();
  constructor(private readonly options: { library: CompanionMemoryLibrary; report?(error: unknown): void }) {}
  async flushPending(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, options: { limitOwners?: number } = {}): Promise<{ owners: number; completed: number; pending: boolean }> {
    for (const [owner, until] of this.failedOwners) if (until <= Date.now()) this.failedOwners.delete(owner);
    const response = await request({ type: 'memory.sources.outbox.owners', limit: Math.max(1, Math.min(128, options.limitOwners ?? 4)), excludedOwners: [...this.failedOwners.keys()].slice(-128) });
    if (!response.ok) throw new Error(response.error ?? '原始来源恢复队列暂不可用。');
    let completed = 0, pending = false;
    const owners = response.memorySourcePendingOwners ?? [];
    for (const owner of owners) {
      try { const result = await this.flush(owner); completed += result.completed; pending ||= result.pending; }
      catch (error) { this.failedOwners.set(owner, Date.now() + 30000); pending = true; this.options.report?.(error); }
    }
    return { owners: owners.length, completed, pending: pending || owners.length >= (options.limitOwners ?? 4) };
  }
  private async remove(session: MemoryLibraryDocumentSession, file: string): Promise<void> {
    for (const target of [file, file + '.meta.json']) {
      await session.text(target, true); // Reject aliases before deleting our exact registered path.
      await unlink(session.file(target)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }
  async flush(owner: string, options: { limit?: number } = {}): Promise<{ completed: number; pending: boolean }> {
    const limit = Math.max(1, Math.min(256, options.limit ?? 64));
    return this.options.library.withDocuments(owner, async session => {
      let completed = 0;
      for (; completed < limit; completed++) {
        const job = (await session.request({ type: 'memory.sources.outbox.claim', companionId: owner })).memorySourceOutbox;
        if (!job) break;
        if (job.companionId !== owner) throw new Error('来源发布所属伙伴不一致。');
        const file = relative(job);
        try {
          if (job.operation === 'retract') await this.remove(session, file);
          else {
            const source = job.source;
            if (!source || source.messageId !== job.sourceId || source.revision !== job.sourceRevision || source.checksum !== job.sourceChecksum
              || checksum(source.content) !== job.sourceChecksum) throw new Error('真实来源发布凭证与原文不一致。');
            await session.directory('来源');
            const existing = await session.text(file, true);
            if (existing !== undefined && existing !== source.content) throw new Error('只读来源副本被外部编辑，未覆盖或倒灌为真实来源。');
            if (existing === undefined) await session.atomic(file, source.content);
            const metadata = JSON.stringify({ schema: 'worldlinebox.companion-source-copy-v1', companionId: owner, ...source, content: undefined,
              authority: '只读原始材料副本；修改本文件或说明不能改变真实消息、来源版本、身份或读取授权。' }, null, 2) + '\n';
            if (await session.text(file + '.meta.json', true) !== metadata) await session.atomic(file + '.meta.json', metadata);
          }
          const accepted = await session.request({ type: 'memory.sources.outbox.complete', id: job.id, leaseToken: job.leaseToken });
          if (job.operation === 'publish' && !accepted.memorySourceOutboxAccepted) await this.remove(session, file);
        } catch (error) {
          await session.request({ type: 'memory.sources.outbox.fail', id: job.id, leaseToken: job.leaseToken,
            error: error instanceof Error ? error.message.slice(0, 1000) : '原始来源发布失败。', retryAfterMs: 30000 }).catch(() => undefined);
          throw error;
        }
      }
      return { completed, pending: completed === limit };
    }, { synchronize: false, sourceDelivery: true });
  }
  async read(scope: { companionId: string; conversationId: string; beforeSequence?: number }, reference: CompanionMemory['sources'][number]): Promise<string> {
    return this.options.library.withDocuments(scope.companionId, async session => {
      const current = async () => (await session.request({ type: 'memory.sources.filter', ...scope, ids: [reference.messageId] })).memorySources?.find(source => source.id === reference.messageId);
      const before = await current();
      if (!before || checksum(before.content) !== reference.checksum) throw new Error('原始来源已撤回、修订或不属于当前伙伴。');
      const file = relative({ sourceId: reference.messageId, sourceRevision: reference.revision, sourceChecksum: reference.checksum });
      const content = await session.text(file), after = await current();
      if (content === undefined || checksum(content) !== reference.checksum || !after || checksum(after.content) !== reference.checksum)
        throw new Error('原始材料文件缺失、被修改或授权已变化；不使用SQL正文替代。');
      return content;
    }, { synchronize: false, readOnly: true, sourceDelivery: true });
  }
}
export const companionMemorySourceFilePath = (job: Pick<CompanionMemorySourceOutbox, 'sourceId' | 'sourceRevision' | 'sourceChecksum'>): string => relative(job);
