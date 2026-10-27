import { z } from 'zod';
import { companionUserStopSchema } from './companion-task-stop';

/** Host execution milestones, never model reasoning text. Each revision belongs
 * to one durable loop/message, including its queued and terminal states. */
export const companionReplyProgressSchema = z.strictObject({
  workId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(), sourceMessageId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  revision: z.number().int().positive(),
  phase: z.enum(['queued', 'waiting', 'context', 'memory', 'thinking', 'tools', 'streaming', 'completed', 'failed', 'cancelled', 'interrupted']),
  detail: z.string().max(500), updatedAt: z.string(), startedAt: z.string(), phaseStartedAt: z.string().optional(), finishedAt: z.string().optional(), stop: companionUserStopSchema.optional(),
  timing: z.strictObject({ elapsedMs: z.number().nonnegative(), activeSince: z.string().optional() }).optional(),
  memory: z.strictObject({ status: z.enum(['running', 'completed', 'unavailable']), count: z.number().int().nonnegative().optional(), injected: z.boolean().optional(), pending: z.boolean().optional() }).optional(),
});
export type CompanionReplyProgress = z.infer<typeof companionReplyProgressSchema>;
export const terminalReplyPhases = new Set<CompanionReplyProgress['phase']>(['completed', 'failed', 'cancelled', 'interrupted']);

/** Only admitted execution intervals count. Queueing, stopped replies and time
 * outside the application cannot accrue execution time. */
export function companionReplyElapsedMs(progress: CompanionReplyProgress, now: number): number | undefined {
  if (!progress.timing) return;
  const end = terminalReplyPhases.has(progress.phase) ? Date.parse(progress.finishedAt ?? progress.updatedAt) : now;
  const since = Date.parse(progress.timing.activeSince ?? '');
  return progress.timing.elapsedMs + (Number.isFinite(since) && Number.isFinite(end) ? Math.max(0, end - since) : 0);
}

export function advanceCompanionReplyTiming(previous: CompanionReplyProgress | undefined, next: CompanionReplyProgress): CompanionReplyProgress {
  const at = Date.parse(next.finishedAt ?? next.updatedAt);
  const elapsedMs = previous ? companionReplyElapsedMs(previous, at) ?? 0 : 0;
  return { ...next, timing: { elapsedMs,
    ...(!terminalReplyPhases.has(next.phase) && next.phase !== 'queued' ? { activeSince: next.updatedAt } : {}) } };
}
