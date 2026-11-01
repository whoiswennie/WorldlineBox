import { z } from 'zod';
import { companionMemoryDescriptorSchema } from './companion-memory';
import { companionMemoryArtifactKindSchema } from './companion-memory-scope';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const revision = z.number().int().positive().safe();
export const companionSourceReferenceExpectationSchema = z.strictObject({ id, conversationId: id,
  checksum: z.string().regex(/^[a-f0-9]{64}$/u), revision: revision.optional() });
export const companionSourceReferenceHeaderSchema = z.strictObject({ id, authorId: id, conversationId: id,
  revision, checksum: z.string().regex(/^[a-f0-9]{64}$/u) });
const scope = { companionId: id, conversationId: id, beforeSequence: z.number().int().nonnegative().safe().optional() };
export const companionReferenceValidationGroupSchema = z.strictObject({ ...scope,
  sources: z.array(companionSourceReferenceExpectationSchema).max(100),
  memories: z.array(z.strictObject({ id, version: revision.optional(), artifactKinds: z.array(companionMemoryArtifactKindSchema).min(1).max(8).optional() })).max(100) });
export const companionReferenceValidationCommandSchema = z.strictObject({ type: z.literal('memory.references.validate'),
  groups: z.array(companionReferenceValidationGroupSchema).min(1).max(100) })
  .refine(value => value.groups.reduce((total, group) => total + group.sources.length + group.memories.length, 0) <= 1000, '引用核验超过单次准确输入预算。');
export const companionReferenceValidationResultSchema = z.strictObject({ groups: z.array(z.strictObject({ ...scope, valid: z.boolean(),
  sourceHeaders: z.array(companionSourceReferenceHeaderSchema).max(10000), memoryHeaders: z.array(companionMemoryDescriptorSchema).max(100) })).min(1).max(100) });
export type CompanionSourceReferenceExpectation = z.infer<typeof companionSourceReferenceExpectationSchema>;
export type CompanionSourceReferenceHeader = z.infer<typeof companionSourceReferenceHeaderSchema>;
export type CompanionReferenceValidationGroup = z.infer<typeof companionReferenceValidationGroupSchema>;
export type CompanionReferenceValidationResult = z.infer<typeof companionReferenceValidationResultSchema>;
