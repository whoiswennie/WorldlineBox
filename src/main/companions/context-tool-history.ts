import type { CompanionLoopCall, CompanionLoopTurn } from '../../shared/companion-loop';
import { normalizeCompanionCapabilityCall } from '../../shared/companion-capability-tools';

function canonical(call: CompanionLoopCall): CompanionLoopCall {
  try { return normalizeCompanionCapabilityCall(call); } catch { return call; }
}

/** VCP evidence can change while already completed external actions remain true.
 * Refresh only affected evidence. Signed native calls are either retained intact
 * or removed as a complete call/result pair; fabricated arguments break signatures. */
export function projectCompanionEvidenceHistory(turns: readonly CompanionLoopTurn[], policy: {
  memoryThroughStep: number; withdrawnThroughStep: number;
}): readonly CompanionLoopTurn[] {
  return turns.map((turn, step) => {
    if (step >= policy.memoryThroughStep && step >= policy.withdrawnThroughStep) return turn;
    const withdrawn = step < policy.withdrawnThroughStep;
    const redacted = new Set(turn.calls.filter(call => withdrawn || canonical(call).name.startsWith('memory.')).map(call => call.id));
    const calls = turn.calls.filter(call => !redacted.has(call.id));
    const results = turn.results?.filter(result => !redacted.has(result.callId));
    return { ...turn, text: '', rawText: '', calls, ...(results ? { results } : {}) };
  });
}
function observationKey(call: CompanionLoopCall): string | undefined {
  const current = canonical(call);
  try {
    const args = JSON.parse(current.arguments) as Record<string, unknown>;
    const stateRead = ['world', 'state', 'routine', 'activity', 'schedule', 'work', 'life_rule'].includes(current.name)
      && ['inspect', 'query', 'list'].includes(String(args.action));
    if (stateRead || ['memory.search', 'memory.read', 'memory.world_query', 'dsh_record', 'read_file'].includes(current.name)) {
      return `${current.name}:${JSON.stringify(Object.fromEntries(Object.entries(args).sort(([left], [right]) => left.localeCompare(right))))}`;
    }
  } catch { /* Invalid legacy calls retain their actual diagnostic result. */ }
  return undefined;
}

/** Reassemble inference history without changing durable evidence or imposing a reasoning token quota.
 * Only superseded identical observations lose repeated bodies; distinct evidence and every action remain available. */
export function projectCompanionToolHistory(turns: readonly CompanionLoopTurn[]): readonly CompanionLoopTurn[] {
  const latest = new Map<string, { step: number; callId: string }>();
  for (const [step, turn] of turns.entries()) for (const call of turn.calls) {
    const key = observationKey(call);
    if (key && turn.results?.some(result => result.callId === call.id)) latest.set(key, { step, callId: call.id });
  }
  return turns.map((turn, step) => ({ ...turn, ...(turn.results ? { results: turn.results.map(result => {
    const call = turn.calls.find(item => item.id === result.callId);
    const key = call && observationKey(call), replacement = key ? latest.get(key) : undefined;
    if (!replacement || replacement.step === step && replacement.callId === result.callId) return result;
    return { callId: result.callId, content: JSON.stringify({ observationReplaced: true, original: { step, callId: result.callId },
      replacedBy: replacement, notice: '相同查询已有更新的完整工具结果，本轮只重建其最新观察；原始执行凭证仍保存在此调用的持久记录中。' }) };
  }) } : {}) }));
}
