import { companionMemoryProcedureContextListSchema, companionMemoryProcedureValidationSchema } from '../../shared/companion-procedure';
import type { CompanionExecutionReadset } from '../../shared/companion-execution-evidence';

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function companionProcedureValidationSources(value: unknown, contentRevision?: number): { valid: boolean; sources: CompanionExecutionReadset['sources'] } {
  if (value === undefined) return { valid: true, sources: [] };
  const parsed = companionMemoryProcedureValidationSchema.safeParse(value);
  if (!parsed.success) return { valid: false, sources: [] };
  const status = parsed.data, passed = status.evidence.filter(entry => entry.outcome === 'passed').length,
    failed = status.evidence.filter(entry => entry.outcome === 'failed').length;
  if (status.successes !== passed || status.failures !== failed || status.state !== (failed ? 'disabled' : passed ? 'validated' : 'unverified')
    || status.evidence.some(entry => contentRevision !== undefined && entry.contentRevision !== contentRevision)) return { valid: false, sources: [] };
  return { valid: true, sources: status.evidence.map(entry => ({ id: entry.sourceMessageId, conversationId: entry.conversationId, checksum: entry.checksum })) };
}
/** Read only a reserved host context field, never arbitrary notebook metadata. */
export function companionProcedureContextSources(value: unknown): { valid: boolean; sources: CompanionExecutionReadset['sources'] } {
  const context = object(value);
  if (context?.proceduralStatus === undefined) return { valid: true, sources: [] };
  const parsed = companionMemoryProcedureContextListSchema.safeParse(context.proceduralStatus);
  if (!parsed.success || new Set(parsed.data.map(item => item.memoryId)).size !== parsed.data.length) return { valid: false, sources: [] };
  const sources: CompanionExecutionReadset['sources'] = [];
  for (const item of parsed.data) {
    const checked = companionProcedureValidationSources({ state: item.state, successes: item.successes, failures: item.failures, evidence: item.evidence }, item.contentRevision);
    if (!checked.valid) return { valid: false, sources: [] }; sources.push(...checked.sources);
  }
  return { valid: true, sources: [...new Map(sources.map(source => [JSON.stringify(source), source])).values()] };
}
