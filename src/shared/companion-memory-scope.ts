import { z } from 'zod';

export const companionMemoryArtifactKindSchema = z.enum(['episode_memory', 'knowledge', 'procedure', 'self_understanding', 'navigation', 'dream_fiction']);
export type CompanionMemoryArtifactKind = z.infer<typeof companionMemoryArtifactKindSchema>;
export const companionMemoryRetrievalScopeSchema = z.enum(['facts', 'episodes', 'knowledge', 'procedures', 'self', 'navigation', 'dream']);
export type CompanionMemoryRetrievalScope = z.infer<typeof companionMemoryRetrievalScopeSchema>;
export const companionMemoryContentKindsSchema = z.array(companionMemoryArtifactKindSchema).min(1).max(6)
  .refine(values => new Set(values).size === values.length, '内容类型不能重复。');
export const COMPANION_MEMORY_SCOPE_KINDS: Record<CompanionMemoryRetrievalScope, readonly CompanionMemoryArtifactKind[]> = {
  facts: ['episode_memory', 'knowledge', 'procedure'], episodes: ['episode_memory'], knowledge: ['knowledge'], procedures: ['procedure'],
  self: ['self_understanding'], navigation: ['navigation'], dream: ['dream_fiction'],
};
export function companionMemoryKinds(scope: CompanionMemoryRetrievalScope = 'facts'): CompanionMemoryArtifactKind[] {
  return [...COMPANION_MEMORY_SCOPE_KINDS[companionMemoryRetrievalScopeSchema.parse(scope)]];
}
export function companionMemoryContentKinds(kinds?: readonly CompanionMemoryArtifactKind[]): CompanionMemoryArtifactKind[] {
  return companionMemoryContentKindsSchema.parse(kinds ? [...kinds] : companionMemoryKinds()).sort();
}
export function companionMemoryKindAllowed(kind: unknown, kinds: readonly CompanionMemoryArtifactKind[]): kind is CompanionMemoryArtifactKind {
  return companionMemoryArtifactKindSchema.safeParse(kind).success && kinds.includes(kind as CompanionMemoryArtifactKind);
}
export const COMPANION_MEMORY_SCOPE_MEANINGS: Record<CompanionMemoryRetrievalScope, string> = {
  facts: '真实经历、资料主张与方法候选；资料中的观点仍属于原作者，方法仍以实际验证条件为限。',
  episodes: '有正式原始来源的经历记忆；叙述中的计划、自述与实际完成分别保留。',
  knowledge: '知识与资料主张；读过、理解、认可、实际使用及验证结果分别说明。',
  procedures: '方法与适用条件；存在步骤不等于已掌握，只承认真实客观试验支持的范围。',
  self: '本人有条件的主观认识及其依据；这些认识不是客观外部事实，未发布候选不等于当前人格。',
  navigation: '派生时间线与主题导航；导航摘要不能独立制造经历、来源或已掌握知识。',
  dream: '明确虚构的梦与联想；内容不是现实事实、实践验证或人格变化的独立依据。',
};
export const companionMemoryTypeScopeSchema = z.strictObject({ schema: z.literal('worldlinebox.memory-type-scope-v2'),
  consumer: companionMemoryRetrievalScopeSchema, contentKinds: companionMemoryContentKindsSchema, meaning: z.string().min(1).max(1000) })
  .refine(value => JSON.stringify([...value.contentKinds].sort()) === JSON.stringify(companionMemoryKinds(value.consumer).sort()),
    '消费者不能扩大自己的内容类型范围。');
