import type { CompanionLoopTurn } from '../../shared/companion-loop';
import { companionMemoryProcedureContextListSchema } from '../../shared/companion-procedure';
import { companionProcedureContextSources } from './memory-procedure-context';

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;

/** Provider projection only. The complete receipt stays in host checkpoints and
 * execution readsets, where its full-graph dependency closure is authoritative.
 * The model needs focused text and observed source meaning, never the database's
 * entire dependency manifest, corpus hashes, protected IDs or runtime identity. */
function memoryReceipt(value: unknown): unknown {
  const receipt = object(value);
  if (!receipt || typeof receipt.text !== 'string' || typeof receipt.revision !== 'string' || typeof receipt.profileKey !== 'string') return value;
  const evidence = object(receipt.evidence);
  const procedures = companionMemoryProcedureContextListSchema.safeParse(receipt.proceduralStatus);
  const proceduralStatus = procedures.success && companionProcedureContextSources(receipt).valid ? procedures.data.map(({ memoryId, contentRevision, state, successes, failures }) =>
    ({ memoryId, contentRevision, state, successes, failures })) : undefined;
  const references = Array.isArray(evidence?.references) ? evidence.references.flatMap(value => {
    const reference = object(value);
    if (!reference || typeof reference.id !== 'string' || !['returned', 'focus_input'].includes(String(reference.role))) return [];
    const sources = Array.isArray(reference.sources) ? reference.sources.flatMap(value => {
      const source = object(value);
      return source && typeof source.messageId === 'string' ? [{ messageId: source.messageId,
        ...(typeof source.revision === 'number' ? { revision: source.revision } : {}) }] : [];
    }) : undefined;
    return [{ id: reference.id, ...(typeof reference.version === 'number' ? { version: reference.version } : {}), role: reference.role,
      ...(sources ? { sources } : {}) }];
  }) : undefined;
  return { text: receipt.text, ...(proceduralStatus?.length ? { proceduralStatus,
    proceduralStatusMeaning: '宿主核验的方法状态：unverified只代表读过、尚无客观试验证据；validated只支持相应适用条件下的实际交付验证，不代表全面熟练；disabled表示有实际失败反证。需要方法步骤和适用限制时用memory.read核查。' } : {}), ...(evidence ? { evidence: {
    ...(evidence.queryClock ? { queryClock: evidence.queryClock } : {}),
    ...(references ? { references } : {}),
    ...(evidence.referenceCoverage ? { referenceCoverage: evidence.referenceCoverage } : {}),
  } } : {}) };
}

/** Only these reserved top-level host fields are projected. User prose, note
 * metadata and nested objects resembling a receipt remain byte-for-byte data. */
function projectPayload(data: Record<string, unknown>): Record<string, unknown> {
  const recall = object(data.memoryRecall);
  const projected = { ...data };
  if (recall) {
    const { timings: _timings, ...visible } = recall; void _timings;
    projected.memoryRecall = { ...visible, ...(recall.context ? { context: memoryReceipt(recall.context) } : {}) };
  }
  if (data.memoryContext !== undefined) projected.memoryContext = memoryReceipt(data.memoryContext);
  delete projected.memorySearchTimings;
  return projected;
}

export function projectCompanionMemoryContextForModel(context: { system: string; user: string }): { system: string; user: string } {
  let data: unknown;
  try { data = JSON.parse(context.user); } catch { return context; }
  const payload = object(data);
  if (!payload || !payload.memoryRecall && payload.memoryContext === undefined && payload.memorySearchTimings === undefined) return context;
  return { system: context.system, user: JSON.stringify(projectPayload(payload)) };
}

/** Tool results are projected only for a real memory capability's matching
 * call/result pair, after host evidence checks have consumed the raw turns. */
export function projectCompanionMemoryToolTurnsForModel(turns: readonly CompanionLoopTurn[]): readonly CompanionLoopTurn[] {
  return turns.map(turn => {
    if (!turn.results?.length) return turn;
    const memoryCalls = new Set(turn.calls.filter(call => call.name === 'memory' || call.name.startsWith('memory.')).map(call => call.id));
    if (!memoryCalls.size) return turn;
    return { ...turn, results: turn.results.map(result => {
      if (!memoryCalls.has(result.callId)) return result;
      let value: unknown;
      try { value = JSON.parse(result.content); } catch { return result; }
      const payload = object(value);
      if (!payload || payload.memoryContext === undefined && payload.memoryRecall === undefined && payload.memorySearchTimings === undefined) return result;
      return { ...result, content: JSON.stringify(projectPayload(payload)) };
    }) };
  });
}
