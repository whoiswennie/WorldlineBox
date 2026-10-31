import { createHash } from 'node:crypto';
import type { CompanionMemory, Companion } from '../../shared/companions';
import { companionCaptureProposalSchema, type CompanionCaptureProposal, type CompanionMemoryJob } from '../../shared/companion-memory';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionModelConfig } from './model';
import type { CompanionMemoryProposalOptions } from './memory-model';
import { companionMemoryProposalIdentity } from './memory-proposal-identity';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Request = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;

/** A paid writer/checker prefix is unpublished staging, with a fresh host lease
 * on every use. It never substitutes SQL for actual historical memory files. */
export class CompanionCaptureProposalCheckpoint {
  private draft?: CompanionCaptureProposal;
  private observed: readonly CompanionMemory[] = [];
  private constructor(private readonly request: Request, private readonly job: CompanionMemoryJob, private readonly identityHash: string) {}
  static async open(request: Request, job: CompanionMemoryJob, config: CompanionModelConfig, companion: Companion,
    contextSources: readonly { id: string; content: string; revision?: number }[], contributions: readonly CompanionMemory[], prohibitionRevision?: string) {
    const identityHash = hash([await companionMemoryProposalIdentity(config, companion.id, 'vcp_experience_journal'),
      { id: companion.id, name: companion.name, persona: companion.persona, description: companion.description },
      job.sourceMessageIds.map(id => [id, job.sourceRevisions[id], job.sourceChecksums[id]]), contextSources.map(source => [source.id, source.revision ?? 1, hash(source.content)]),
      contributions.map(note => [note.id, note.contentRevision]), prohibitionRevision]);
    const checkpoint = new CompanionCaptureProposalCheckpoint(request, job, identityHash);
    const response = await request({ type: 'memory.jobs.proposal.read', id: job.id, leaseToken: job.leaseToken });
    if (!response.ok) throw Error(response.error ?? '日记未发布提案暂不可读取。');
    if (response.memoryCaptureProposal?.identityHash === identityHash) checkpoint.draft = response.memoryCaptureProposal;
    return checkpoint;
  }
  async restore(): Promise<{ memories: CompanionMemory[]; sourceContributions: CompanionMemory[] } | undefined> {
    if (!this.draft) return;
    const scope = { companionId: this.job.companionId, conversationId: this.job.conversationId, beforeSequence: this.job.throughSequence };
    const memories: CompanionMemory[] = [];
    for (const reference of this.draft.readMemories) {
      const response = await this.request({ type: 'memory.revision.read', ...scope, id: reference.id, contentRevision: reference.contentRevision });
      const actual = response.memories?.find(note => note.id === reference.id && note.contentRevision === reference.contentRevision);
      if (!response.ok || !actual) throw Error('日记提案曾读的真实历史文件尚不可核验。');
      const valid = await this.request({ type: 'memory.frozen.valid', ...scope, memories: [{ id: reference.id, version: reference.version,
        contentRevision: reference.contentRevision, sources: actual.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, revision: source.revision, checksum: source.checksum })) }] });
      if (!valid.ok || !valid.memoryFrozenValid) throw Error('日记提案曾读的正文、来源或权限已经撤回。');
      memories.push({ ...actual, version: reference.version });
    }
    return { memories, sourceContributions: memories.filter(note => this.draft!.sourceContributionIds.includes(note.id)) };
  }
  options(memories: readonly CompanionMemory[], contributions: readonly CompanionMemory[], stateRevision?: number): CompanionMemoryProposalOptions {
    this.observed = memories;
    return { ...(this.draft ? { proposal: this.draft.proposal } : {}), onProposal: async proposal => {
      const next = companionCaptureProposalSchema.parse({ identityHash: this.identityHash,
        sourceVersions: this.job.sourceMessageIds.map(id => ({ id, revision: this.job.sourceRevisions[id], checksum: this.job.sourceChecksums[id] })),
        readMemories: memories.map(note => ({ id: note.id, version: note.version, contentRevision: note.contentRevision })),
        sourceContributionIds: contributions.map(note => note.id), expectedStateRevision: this.draft ? this.draft.expectedStateRevision : stateRevision,
        proposal, checks: this.draft?.checks ?? [] });
      this.draft = next; await this.save();
    }, prohibitionCheck: async (input, generate) => {
      if (!this.draft) throw Error('禁记检查前缺少实际已生成日记提案。');
      const key = hash([this.identityHash, input]);
      const previous = this.draft.checks.find(check => check.key === key);
      if (previous) return previous.allowed;
      const allowed = await generate(); this.draft.checks.push({ key, allowed }); await this.save(); return allowed;
    } };
  }
  modelConfig(config: CompanionModelConfig): CompanionModelConfig {
    return { ...config, providerLifecycle: { beforeDispatch: async () => {
      // Recheck after the actual model queue wait, before HTTP. A withdrawn
      // queued input cannot be sent merely because its
      // writer or checker had once acquired a legal snapshot.
      await this.validateForModel();
      const finish: Awaited<ReturnType<NonNullable<CompanionModelConfig['providerLifecycle']>['beforeDispatch']>> = config.providerLifecycle
        ? await config.providerLifecycle.beforeDispatch() : async () => undefined;
      try { await this.validateForModel(); return finish; }
      catch (error) { await finish('cancelled_before_send', 0); throw error; }
    } } };
  }
  private async validateForModel(): Promise<void> {
    const lease = await this.request({ type: 'memory.jobs.proposal.read', id: this.job.id, leaseToken: this.job.leaseToken });
    if (!lease.ok) throw Error(lease.error ?? '编码来源租约已不可用。');
    const scope = { companionId: this.job.companionId, conversationId: this.job.conversationId, beforeSequence: this.job.throughSequence };
    for (const memory of this.observed) {
      const valid = await this.request({ type: 'memory.frozen.valid', ...scope, memories: [{ id: memory.id, version: memory.version,
        contentRevision: memory.contentRevision, sources: memory.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum, revision: source.revision })) }] });
      if (!valid.ok || !valid.memoryFrozenValid) throw Error('编码实际已读来源在模型排队期间撤回。');
      const body = await this.request({ type: 'memory.revision.read', ...scope, id: memory.id, contentRevision: memory.contentRevision! });
      if (!body.ok || !body.memories?.some(actual => actual.id === memory.id && actual.content === memory.content)) throw Error('编码已读的真实历史文件已变化。');
    }
  }
  expectedStateRevision(fallback?: number): number | undefined { return this.draft ? this.draft.expectedStateRevision : fallback; }
  private async save(): Promise<void> {
    const response = await this.request({ type: 'memory.jobs.proposal.save', id: this.job.id, leaseToken: this.job.leaseToken, proposal: this.draft! });
    if (!response.ok) throw Error(response.error ?? '日记提案尚未完成持久化，未标记来源完成。');
  }
}
