import { z } from 'zod';
import { companionMemoryTagSchema } from './companion-memory';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionMemoryTagStateSchema = z.enum(['pending', 'running', 'waiting_model', 'failed', 'parked', 'abandoned', 'completed', 'cancelled', 'stale']);
export const companionMemoryTagJobSchema = z.object({ id, leaseToken: id, companionId: id, noteId: id,
  version: z.number().int().positive(), content: z.string().min(1).max(65536), attempts: z.number().int().positive(),
  failureCount: z.number().int().nonnegative(), cycleFailureCount: z.number().int().nonnegative() });
export type CompanionMemoryTagJob = z.infer<typeof companionMemoryTagJobSchema>;
export const companionMemoryTagStatusSchema = z.object({ pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
  waitingModel: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative(),
  note: z.object({ noteId: id, version: z.number().int().positive(), state: companionMemoryTagStateSchema, error: z.string().optional() }).optional() });
export const companionMemoryTagCommands = [
  z.strictObject({ type: z.literal('memory.tags.claim'), companionId: id.optional(), leaseMs: z.number().int().min(1000).max(600000).default(120000) }),
  z.strictObject({ type: z.literal('memory.tags.heartbeat'), id, leaseToken: id, leaseMs: z.number().int().min(1000).max(600000).default(120000) }),
  z.strictObject({ type: z.literal('memory.tags.validate'), id, leaseToken: id }),
  z.strictObject({ type: z.literal('memory.tags.complete'), id, leaseToken: id, tags: z.array(companionMemoryTagSchema).min(1).max(50) }),
  z.strictObject({ type: z.literal('memory.tags.defer'), id, leaseToken: id, reason: z.enum(['needs_model', 'retry', 'admission', 'cancelled', 'stale']),
    error: z.string().max(1000), retryAfterMs: z.number().int().min(1000).max(86_400_000).default(30000) }),
  z.strictObject({ type: z.literal('memory.tags.status'), companionId: id, noteId: id.optional() }),
  z.strictObject({ type: z.literal('memory.tags.cancel'), companionId: id, noteId: id }),
  z.strictObject({ type: z.literal('memory.tags.retry'), companionId: id, noteId: id.optional() }),
  z.strictObject({ type: z.literal('memory.tags.retry-admission'), companionId: id.optional() }),
] as const;
