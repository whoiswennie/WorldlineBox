import type { CompanionLoopCall, CompanionLoopTurn } from '../../shared/companion-loop';
import { normalizeCompanionCapabilityCall } from '../../shared/companion-capability-tools';
import { createHash } from 'node:crypto';

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

/** A scoped progress hint, not a lifetime turn limit. Native receipts stay intact.
 * Directory reads through either public entrance are the same observation; new
 * evidence or an action resets the hint. DSH polling is deliberately excluded. */
export function companionRepeatedObservation(turns: readonly CompanionLoopTurn[]): { repetitions: number; categories: string[] } | undefined {
  const seen = new Set<string>();
  let repetitions = 0;
  const categories = new Set<string>();
  for (const turn of turns.slice(-32)) {
    if (!turn.calls.length || !turn.results) { seen.clear(); repetitions = 0; categories.clear(); continue; }
    const observations: Array<{ key: string; category: string }> = [];
    let otherAction = false;
    for (const call of turn.calls) {
      const normalized = canonical(call);
      try {
        const args = JSON.parse(normalized.arguments);
        // Inspect can accompany a directory read, but clock ticks alone do not
        // constitute progress towards contacting someone.
        if (normalized.name === 'world' && args.action === 'inspect') continue;
        if (!(normalized.name === 'memory.world_query' || normalized.name === 'world' && args.action === 'query')) { otherAction = true; break; }
        const result = JSON.parse(turn.results.find(result => result.callId === call.id)?.content ?? 'null');
        if (!result?.ok || !result.worldKnowledge) { otherAction = true; break; }
        const { category, items } = result.worldKnowledge;
        observations.push({ category, key: createHash('sha256').update(JSON.stringify({ category, items })).digest('hex') });
      } catch { otherAction = true; break; }
    }
    if (otherAction || !observations.length) { seen.clear(); repetitions = 0; categories.clear(); continue; }
    const hasNewEvidence = observations.some(observation => !seen.has(observation.key));
    if (hasNewEvidence) { repetitions = 0; categories.clear(); }
    else repetitions++;
    for (const observation of observations) { seen.add(observation.key); categories.add(observation.category); }
  }
  return repetitions >= 3 ? { repetitions, categories: [...categories] } : undefined;
}
