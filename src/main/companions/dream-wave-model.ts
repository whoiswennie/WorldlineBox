import { companionBehaviorSystem } from './asset-behavior-defaults';
import { z } from 'zod';
import type { Companion } from '../../shared/companions';
import type { VcpMemoryDreamWaveResult } from '../vcp-memory/dream-contracts';
import { generateCompanionStructured, CompanionModelError, type CompanionModelConfig, type CompanionModelOptions } from './model';
import { companionDreamInvestigationProposalSchema } from '../../shared/companion-memory-investigation';

const narrative = z.strictObject({ text: z.string().trim().min(1).max(4000), relatedMemoryIds: z.array(z.string()).min(1).max(30),
  investigations: z.array(companionDreamInvestigationProposalSchema).max(3).optional() }).nullable();

/** Fiction consumes the bounded original wave. It never produces knowledge,
 * evidence quotes, emotional rewards or authoritative reflection candidates. */
export async function generateCompanionDreamNarrative(input: { companion: Companion; wave: VcpMemoryDreamWaveResult; mode?: 'sleep_dream' | 'rehearsal_dream' }, config: CompanionModelConfig,
  signal?: AbortSignal, options: Pick<CompanionModelOptions, 'fetchFn' | 'timeoutMs'> = {}) {
  if (input.wave.owner.companionId !== input.companion.id) throw new Error('梦境浪潮不属于本人。');
  const groups = input.wave.stages;
  const ids = new Set([...groups.recent.seeds, ...groups.recent.resonanceL1, ...groups.recent.cascadeL2,
    ...groups.mid.seeds, ...groups.mid.cascadeL1, ...groups.deep.recalls].map(note => note.id));
  if (!groups.recent.seeds.length || !ids.size) return null;
  const value = narrative.safeParse(await generateCompanionStructured({
    system: companionBehaviorSystem(config, 'companion_dream_wave_narrative', `【宿主梦叙述合同】本阶段只有虚构叙述，无工具、学习验证、事实/情绪/关系/任务更改权限。mode=${input.mode ?? 'rehearsal_dream'}；rehearsal_dream不是昨夜真实睡梦，不补造离线思考。只用当前owner已获权stages资料，不向群或其他伙伴泄露。严格返回JSON {text,relatedMemoryIds,investigations?}或null；relatedMemoryIds只列本篇实际使用的给定日记ID。investigations最多3项，仅登记待核查question/hypothesis及可选的authorized_source_contains原文检验规则；不是结论、证据、授权或现实行动。没有明确授权和真实阅读回执时等待核查；检验命中也只代表资料中存在原文，不证明假设为事实。梦中想象不能转成真实经历、方法验证或外部成果。`, { ...input.companion, mode: input.mode }),
    user: JSON.stringify({ purpose: 'companion_dream_wave_narrative', self: { id: input.companion.id, name: input.companion.name },
      reality: 'private_fiction_not_real_world_evidence', mode: input.mode ?? 'rehearsal_dream', clock: { now: input.wave.now, domain: input.wave.clockDomain },
      boundaries: input.wave.boundaries, stages: groups, outputSchema: z.toJSONSchema(narrative, { io: 'input' }) }),
  }, config, signal, { ...options, responseSchema: narrative,
    repairPreserveCollections: [{ path: ['relatedMemoryIds'], fields: [] }, { path: ['investigations'], fields: ['question', 'hypothesis', 'relatedMemoryIds', 'test'] }],
    repairPreserveValues: [{ path: ['text'] }] }));
  if (!value.success || value.data && (new Set(value.data.relatedMemoryIds).size !== value.data.relatedMemoryIds.length
    || value.data.relatedMemoryIds.some(id => !ids.has(id)) || value.data.investigations?.some(proposal => proposal.relatedMemoryIds.some(id => !ids.has(id))))) throw new CompanionModelError('INVALID_RESPONSE', '梦叙述引用了未实际读取的浪潮记忆。');
  return value.data;
}
