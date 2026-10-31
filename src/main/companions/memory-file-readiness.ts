import type { CompanionMemory } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemoryLibrary } from './memory-library';
import type { CompanionMemorySourceFiles } from './memory-source-files';
import { companionMemoryHistoryArtifactId, type CompanionMemoryHistoryFiles } from './memory-history-files';
import { companionMemorySourceArtifactId } from './memory-source-files';
import { CompanionMemoryFilesPending } from './memory-files-pending';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
/** A finite captured dependency closure, never an owner-wide readiness drain.
 * An already committed body is read strictly even when another writer is busy.
 * Only actual pending SQL publication work may be attempted; no missing
 * committed file is reconstructed and no active/held job is stolen. */
export class CompanionMemoryFileReadiness {
  constructor(private readonly options: { request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
    library: CompanionMemoryLibrary; sources: CompanionMemorySourceFiles; history: CompanionMemoryHistoryFiles }) {}
  async ensure(scope: Scope, id: string, contentRevision: number, signal?: AbortSignal): Promise<CompanionMemory> {
    const active = new Set<string>(), completed = new Map<string, CompanionMemory>();
    const visit = async (id: string, contentRevision: number): Promise<CompanionMemory> => {
      signal?.throwIfAborted(); const key = `${id}:${contentRevision}`, cached = completed.get(key); if (cached) return cached;
      if (active.has(key) || active.size + completed.size >= 10_000) throw new Error('准确记忆修订依赖存在环路或超出可核验闭包。');
      active.add(key);
      try {
        const inspect = async () => {
          signal?.throwIfAborted(); const result = await this.options.request({ type: 'memory.files.inspect', ...scope, id, contentRevision });
          if (!result.ok || !result.memoryFileReadiness) throw new Error(result.error || '准确记忆文件发布凭证缺失。'); return result.memoryFileReadiness;
        };
        const initial = await inspect();
        if (initial.state !== 'published') {
          await this.options.library.withDocuments(scope.companionId, async session => {
            // A pending outbox can follow an already committed stage. Its
            // acknowledged bytes remain strict even if the final SQL receipt
            // was interrupted; do not relabel external damage as a wait.
            for (const artifactId of [companionMemoryHistoryArtifactId(id, contentRevision), `memory:${id}`]) {
              const existing = await session.registry.get(artifactId, true);
              if (existing?.publicationState === 'committed') await session.registry.read({ artifactId, consumer: 'audit' });
            }
          }, { readOnly: true, sourceDelivery: true });
          for (const dependency of initial.descriptor.dependencies) await visit(dependency.id, dependency.contentRevision);
          for (const source of initial.descriptor.sources) {
            signal?.throwIfAborted();
            const registered = () => this.options.library.withDocuments(scope.companionId, session => session.registry.get(companionMemorySourceArtifactId(source.id, source.revision), true), { readOnly: true, sourceDelivery: true });
            const exists = await registered();
            if (!exists) {
              const job = initial.sourceJobs.find(job => job.sourceId === source.id && job.sourceRevision === source.revision && job.sourceChecksum === source.checksum);
              if (!job) throw new Error('准确来源缺少系统发布作业，不能从SQL重建。');
              if (job.state === 'done') throw new Error('已提交的来源文件缺失，不能从SQL重建。');
              if (!['pending', 'failed'].includes(job.state)) throw new CompanionMemoryFilesPending('准确来源的发布作业正在运行或已搁置。');
              await this.options.sources.flush(scope.companionId, { jobId: job.id, limit: 1, ifIdle: true });
            }
            // The real port checks bytes plus the exact SQL source ACL before
            // and after reading; metadata readiness never stands in for it.
            const reference = { messageId: source.id, revision: source.revision, checksum: source.checksum };
            try { await this.options.sources.read({ ...scope, conversationId: source.conversationId }, reference); }
            catch (error) {
              if (exists || await registered()) throw error;
              const current = await inspect();
              if (current.sourceJobs.some(job => job.sourceId === source.id && job.sourceRevision === source.revision && job.sourceChecksum === source.checksum && job.state !== 'done'))
                throw new CompanionMemoryFilesPending('准确来源尚未完成正式发布。');
              throw error;
            }
          }
          const current = await inspect();
          if (current.state !== 'published') {
            if (!current.historyJob) throw new Error('准确历史修订缺少系统发布作业。');
            if (current.historyJob.state === 'done') throw new Error('已完成的历史发布缺少正式提交凭证。');
            if (!['pending', 'failed'].includes(current.historyJob.state)) throw new CompanionMemoryFilesPending('准确历史修订正在运行或已搁置。');
            await this.options.history.flush(scope.companionId, { memoryId: id, contentRevision, operation: 'publish', limit: 1, ifIdle: true });
            if ((await inspect()).state !== 'published') throw new CompanionMemoryFilesPending();
          }
        }
        signal?.throwIfAborted(); const actual = await this.options.history.read(scope, id, contentRevision);
        completed.set(key, actual); return actual;
      } finally { active.delete(key); }
    };
    return visit(id, contentRevision);
  }
}
