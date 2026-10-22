import { z } from 'zod';
import { companionWorldQuerySchema } from './companion-knowledge';
import { companionMemoryCandidateSchema, companionMemoryForgetSchema, companionMemorySearchSchema, companionMemoryTagSchema } from './companion-memory';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
// Scope comes from the host, never from model arguments.
export const companionMemoryToolArgumentsSchemas = {
    'memory.world_query': companionWorldQuerySchema,
    'memory.search': companionMemorySearchSchema.omit({ companionId: true, conversationId: true, beforeSequence: true }).strict(),
    'memory.read': z.strictObject({ id, sourceLimit: z.number().int().min(1).max(100).default(30), sourceCursor: z.number().int().nonnegative().optional() }),
    'memory.record': z.strictObject({ candidate: companionMemoryCandidateSchema }),
    'memory.revise': z.strictObject({ id, expectedVersion: z.number().int().positive(), candidate: companionMemoryCandidateSchema }),
    'memory.organize': z.strictObject({ ids: z.array(id).min(1).max(100), tags: z.array(companionMemoryTagSchema).max(50).default([]) }),
    'memory.forget': companionMemoryForgetSchema.omit({ companionId: true, conversationId: true, beforeSequence: true }).extend({ requestMessageId: id }).strict(),
} as const;
export type CompanionMemoryToolName = keyof typeof companionMemoryToolArgumentsSchemas;
