import { createHash } from 'node:crypto';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { companionWorldProposalSchema, type CompanionWorldProposal } from '../../shared/companion-world-proposals';
import type { CompanionMemoryProposalOptions } from './memory-model';

export async function companionWorldProposalCheckpoint(input: {
  id: string; leaseToken: string; phase: CompanionWorldProposal['phase']; basis: string; prohibitionRevision: string; expectedStateRevision?: number;
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  current(): Promise<boolean>;
}) {
  const current = async () => { if (!await input.current()) throw new Error('维护提案的角色行为文件或模型配置已变化。'); };
  const request = async (command: CompanionStorageCommand) => { const result = await input.request(command); if (!result.ok) throw new Error(result.error ?? '维护提案检查点不可用。'); return result; };
  await current();
  let saved = (await request({ type: 'world.job.proposal.read', id: input.id, leaseToken: input.leaseToken,
    phase: input.phase, basis: input.basis, prohibitionRevision: input.prohibitionRevision })).worldProposal;
  const persist = async (value: CompanionWorldProposal) => { await current(); await request({ type: 'world.job.proposal.save', id: input.id, leaseToken: input.leaseToken, proposal: value }); saved = value; };
  const options: CompanionMemoryProposalOptions = {
    ...(saved ? { proposal: saved.writer } : {}),
    onProposal: async writer => {
      if (saved) return;
      await persist(companionWorldProposalSchema.parse({ phase: input.phase, basis: input.basis, prohibitionRevision: input.prohibitionRevision,
        expectedStateRevision: input.expectedStateRevision, writer, checks: {} }));
    },
    prohibitionCheck: async (value, generate) => {
      await current();
      if (!saved) throw new Error('付费拟稿尚未持久保存，不能开始后续语义核验。');
      // A read rechecks the current lease, exact source/content closure and
      // policy before using either an old proposal or an allowed/denied check.
      const verified = (await request({ type: 'world.job.proposal.read', id: input.id, leaseToken: input.leaseToken,
        phase: input.phase, basis: input.basis, prohibitionRevision: input.prohibitionRevision })).worldProposal;
      if (!verified) throw new Error('付费提案检查点已失效。'); saved = verified;
      const key = createHash('sha256').update(JSON.stringify(value)).digest('hex'), previous = saved.checks[key];
      if (previous !== undefined) return previous;
      const allowed = await generate(); await persist({ ...saved, checks: { ...saved.checks, [key]: allowed } }); return allowed;
    },
  };
  return { options, get writer() { return saved?.writer; },
    get expectedStateRevision() { return saved ? saved.expectedStateRevision : input.expectedStateRevision; } };
}
