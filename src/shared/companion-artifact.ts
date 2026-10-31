import { z } from 'zod';

export const companionArtifactIdSchema = z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/u)
  .refine(value => !['__proto__', 'prototype', 'constructor'].includes(value), 'Reserved identifier.');
export const companionArtifactHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const companionArtifactPathSchema = z.string().min(1).max(768).refine(value => {
  const parts = value.split('/');
  return parts.length <= 10 && parts.every(part => !!part && part !== '.' && part !== '..'
    && !/[\\/:<>"|?*]/u.test(part) && ![...part].some(character => character.charCodeAt(0) < 32) && !/[. ]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}, 'Expected a safe owner-relative path.');
export const companionArtifactKindSchema = z.enum(['persona_current', 'origin_snapshot', 'role_guidance', 'processor_prompt',
  'episode_memory', 'knowledge', 'procedure', 'self_understanding', 'navigation', 'source_evidence', 'revision_history',
  'growth_goal', 'growth_publish', 'dream_fiction', 'appearance', 'context_snapshot', 'task_reference',
  'runtime_index', 'host_metadata', 'diagnostic_log']);
export const companionArtifactConsumerSchema = z.enum(['identity', 'role', 'processor', 'episode_recall', 'knowledge_recall',
  'self_recall', 'navigation', 'reflection', 'memory_consolidation', 'knowledge_review', 'self_integration',
  'persona_publish', 'source_verification', 'audit', 'appearance', 'host', 'task_reference', 'dream']);
export type CompanionArtifactKind = z.infer<typeof companionArtifactKindSchema>;
export type CompanionArtifactConsumer = z.infer<typeof companionArtifactConsumerSchema>;

/** These are maximum capabilities, never inferred from a filename or granted by a sidecar. */
export const COMPANION_ARTIFACT_CONSUMERS: Record<CompanionArtifactKind, readonly CompanionArtifactConsumer[]> = {
  persona_current: ['identity', 'audit'], origin_snapshot: ['audit'], role_guidance: ['role', 'audit'], processor_prompt: ['processor', 'audit'],
  episode_memory: ['episode_recall', 'reflection', 'memory_consolidation', 'source_verification', 'audit'],
  knowledge: ['knowledge_recall', 'knowledge_review', 'reflection', 'source_verification', 'audit'],
  procedure: ['knowledge_recall', 'knowledge_review', 'reflection', 'source_verification', 'audit'],
  self_understanding: ['self_recall', 'reflection', 'self_integration', 'persona_publish', 'source_verification', 'audit'],
  navigation: ['navigation', 'audit'], source_evidence: ['source_verification', 'audit'], revision_history: ['audit'],
  growth_goal: ['self_integration', 'persona_publish', 'audit'], growth_publish: ['audit'], dream_fiction: ['dream', 'audit'],
  appearance: ['appearance', 'audit'], context_snapshot: ['audit'], task_reference: ['task_reference', 'audit'],
  runtime_index: ['host'], host_metadata: ['host', 'audit'], diagnostic_log: ['host', 'audit'],
};
export const companionArtifactReferenceSchema = z.strictObject({ artifactId: companionArtifactIdSchema,
  contentRevision: z.number().int().positive(), contentHash: companionArtifactHashSchema });
export const companionArtifactVisibilitySchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('owner') }), z.strictObject({ scope: z.literal('public') }),
  z.strictObject({ scope: z.literal('audience'), audienceIds: z.array(z.string().min(1).max(160)).min(1).max(128) }),
]);
export const companionArtifactSchema = z.strictObject({ schema: z.literal('worldlinebox.companion-artifact-v2'),
  artifactId: companionArtifactIdSchema, ownerId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), kind: companionArtifactKindSchema,
  producer: z.strictObject({ kind: z.enum(['creation', 'system', 'host']), id: companionArtifactIdSchema }),
  relativePath: companionArtifactPathSchema, contentRevision: z.number().int().positive(), contentHash: companionArtifactHashSchema,
  sourceRefs: z.array(companionArtifactReferenceSchema).max(512), dependencyRefs: z.array(companionArtifactReferenceSchema).max(512),
  visibility: companionArtifactVisibilitySchema, allowedConsumers: z.array(companionArtifactConsumerSchema).min(1).max(24),
  retentionClass: z.enum(['current', 'evidence', 'history', 'ephemeral', 'runtime']),
  publicationState: z.enum(['committed', 'revoked']), operationId: companionArtifactIdSchema,
  committedAt: z.iso.datetime(),
}).superRefine((value, context) => {
  if (value.allowedConsumers.some(consumer => !COMPANION_ARTIFACT_CONSUMERS[value.kind].includes(consumer)))
    context.addIssue({ code: 'custom', path: ['allowedConsumers'], message: 'Consumer exceeds the artifact kind capability.' });
});
export type CompanionArtifact = z.infer<typeof companionArtifactSchema>;
export type CompanionArtifactReference = z.infer<typeof companionArtifactReferenceSchema>;
export type CompanionArtifactVisibility = z.infer<typeof companionArtifactVisibilitySchema>;
export const COMPANION_ARTIFACT_ROOTS: Record<CompanionArtifactKind, readonly string[]> = {
  persona_current: ['profile.md'], origin_snapshot: ['演化/起点/'], role_guidance: ['提示词/角色指导/'],
  processor_prompt: ['提示词/处理职能/'], episode_memory: ['记忆/经历/'], knowledge: ['记忆/知识/'], procedure: ['记忆/知识/'],
  self_understanding: ['记忆/自我认识/'], navigation: ['记忆/导航/'], source_evidence: ['证据/来源/'],
  revision_history: ['证据/历史/'], growth_goal: ['演化/目标/'], growth_publish: ['演化/发布/'],
  dream_fiction: ['演化/联想/'], appearance: ['形象/'], context_snapshot: ['.运行/上下文/'],
  task_reference: ['.运行/引用/'], runtime_index: ['.运行/索引/', '.运行/视图/'],
  host_metadata: ['instance.json', 'profile.fragments.json', '认知策略.json', '提示词/manifest.json', '.伙伴配置.json', '.运行/日程职能版本.json'], diagnostic_log: ['.运行/诊断/'],
};
export function companionArtifactPathMatchesKind(kind: CompanionArtifactKind, relativePath: string): boolean {
  if (!companionArtifactPathSchema.safeParse(relativePath).success) return false;
  return COMPANION_ARTIFACT_ROOTS[kind].some(root => root.endsWith('/') ? relativePath.startsWith(root) : relativePath === root);
}
