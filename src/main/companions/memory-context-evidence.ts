import { companionExecutionReadsetSchema } from '../../shared/companion-execution-evidence';

type Dependency = { id: string; version: number };
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Only call on a known host memoryContext field. Physical inputs are a safe
 * dependency superset, distinct from actual sentence/output citations. Neither
 * a query's current corpus revision nor its model profile revokes past facts. */
export function companionMemoryContextDependencies(value: unknown): { complete: boolean; malformed: boolean; memories: Dependency[] } {
  const context = object(value), evidence = object(context?.evidence);
  if (!context || typeof context.text !== 'string' || !evidence) return { complete: false, malformed: false, memories: [] };
  if (evidence.dependencyCoverage === 'complete') {
    const parsed = companionExecutionReadsetSchema.shape.memories.safeParse(evidence.dependencies);
    return parsed.success ? { complete: true, malformed: false, memories: parsed.data } : { complete: false, malformed: true, memories: [] };
  }
  const references = Array.isArray(evidence.references) ? evidence.references : [];
  const memories: Dependency[] = [];
  let valid = Array.isArray(evidence.references);
  for (const value of references) {
    const reference = object(value);
    if (!['returned', 'focus_input'].includes(String(reference?.role))) { valid = false; continue; }
    const parsed = companionExecutionReadsetSchema.shape.memories.element.safeParse({ id: reference?.id, version: reference?.version });
    if (parsed.success) memories.push(parsed.data); else valid = false;
  }
  // An empty observer list with nonempty legacy text cannot prove its inputs.
  return { complete: evidence.referenceCoverage === 'observed' && valid && (memories.length > 0 || context.text.length === 0), malformed: false, memories };
}
