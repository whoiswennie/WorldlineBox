import { z } from 'zod';
import { companionKnowledgeCommandSchema } from './companion-knowledge-store';
import { companionWorldQuerySchema } from './companion-knowledge';
import { companionMemoryCandidateSchema, companionMemoryForgetSchema, companionMemorySearchSchema, companionMemoryTagSchema, companionMemoryConsolidateSchema } from './companion-memory';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
// Scope comes from the host, never from model arguments.
export const companionMemoryToolArgumentsSchemas = {
    'memory.world_query': companionWorldQuerySchema,
    'memory.search': companionMemorySearchSchema.omit({ companionId: true, conversationId: true, beforeSequence: true }).strict(),
    'memory.retrieval_modes': z.strictObject({}),
    'memory.read': z.strictObject({ id, sourceLimit: z.number().int().min(1).max(100).default(30), sourceCursor: z.number().int().nonnegative().optional() }),
    'memory.record': z.strictObject({ candidate: companionMemoryCandidateSchema }),
    'memory.revise': z.strictObject({ id, expectedVersion: z.number().int().positive(), candidate: companionMemoryCandidateSchema }),
    'memory.organize': z.strictObject({ ids: z.array(id).min(1).max(100), tags: z.array(companionMemoryTagSchema).max(50).default([]) }),
    'memory.consolidate': companionMemoryConsolidateSchema,
    'memory.knowledge': z.strictObject(Object.fromEntries(Object.entries(companionKnowledgeCommandSchema.shape)
      .filter(([key]) => !['type', 'companionId', 'conversationId', 'beforeSequence'].includes(key))) as Omit<typeof companionKnowledgeCommandSchema.shape, 'type' | 'companionId' | 'conversationId' | 'beforeSequence'>),
    'memory.forget': companionMemoryForgetSchema.omit({ companionId: true, conversationId: true, beforeSequence: true }).extend({ requestMessageId: id }).strict(),
} as const;
export type CompanionMemoryToolName = keyof typeof companionMemoryToolArgumentsSchemas;
