import { createHash } from 'node:crypto';
import type { CompanionLoopCall, CompanionLoopTurn } from '../../shared/companion-loop';
import { normalizeCompanionCapabilityCall } from '../../shared/companion-capability-tools';

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const transient = new Set(['operationId', 'callId', 'requestId', 'traceId', 'checkedAt', 'fetchedAt', 'generatedAt', 'observedAt', 'observedAtVirtual',
  'observedRealAt', 'realNow', 'virtualNow', 'latencyMs', 'durationMs']);
function normalized(call: CompanionLoopCall) { try { return normalizeCompanionCapabilityCall(call); } catch { return call; } }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  return object ? Object.fromEntries(Object.entries(object).filter(([key]) => !transient.has(key)).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)])) : value;
}
/** Search diagnostics describe the cost/time of observing facts, not new facts.
 * Keep every actual hit, source, corpus/permission version, scope and argument.
 * Only these typed receipt fields are volatile; source timestamps inside the
 * returned memories remain part of the observation. */
function memorySearchFacts(result: Record<string, unknown>): Record<string, unknown> {
  const { memorySearchTimings: _timings, ...facts } = result; void _timings;
  const context = record(facts.memoryContext), evidence = context && record(context.evidence);
  if (context && evidence) {
    const { capturedAt: _captured, queryClock, ...observed } = evidence; void _captured;
    const clock = record(queryClock);
    if (clock) { const { now: _now, ...domain } = clock; void _now; observed.queryClock = domain; }
    else if (queryClock !== undefined) observed.queryClock = queryClock;
    facts.memoryContext = { ...context, evidence: observed };
  }
  return facts;
}
export interface CompanionAgentNoProgressProof { fromStep: number; throughStep: number; repetitions: number; observationDigest: string; tools: string[]; kind?: 'empty_authorized_memory' }
export class CompanionAgentNoProgressError extends Error {
  readonly code = 'COMPANION_AGENT_NEEDS_ATTENTION';
  constructor(readonly proof: CompanionAgentNoProgressProof) {
    super('伙伴连续读取了相同资料，未获得新内容、版本或行动进展。真实回执已保存，任务仍未完成；需新消息、资料变化或明确调整后继续，不能原样反复查询。');
    this.name = 'CompanionAgentNoProgressError';
  }
}
function observation(turn: CompanionLoopTurn): { digest: string; tools: string[]; kind?: CompanionAgentNoProgressProof['kind'] } | undefined {
  if (!turn.calls.length || !turn.results || turn.calls.length !== turn.results.length) return;
  const queries: unknown[] = [], tools: string[] = []; let allEmptyCorpus = true;
  for (const call of turn.calls) {
    try {
      const current = normalized(call), args = record(JSON.parse(current.arguments));
      if (!args) return;
      const worldQuery = current.name === 'memory.world_query' || current.name === 'world' && args.action === 'query';
      // Keep this allowlist narrow. In particular DSH await/record polling,
      // reads with unknown semantics and every write/send reset the guard.
      if (!worldQuery && current.name !== 'memory.search' && current.name !== 'memory.read') return;
      const receipt = turn.results.find(result => result.callId === call.id), result = receipt && record(JSON.parse(receipt.content));
      if (!result || result.ok !== true || result.error) return;
      const retrieval = record(result.memoryRetrieval), page = record(result.memoryPage);
      const emptyCorpus = current.name === 'memory.search' && retrieval?.authorizedCorpusEmpty === true
        && typeof retrieval.authorizedCorpusRevision === 'string' && retrieval.authorizedCorpusRevision.length > 0
        && retrieval.resultCount === 0 && Array.isArray(page?.items) && page.items.length === 0 && page.hasMore === false;
      allEmptyCorpus &&= emptyCorpus;
      if (emptyCorpus) {
        queries.push({ name: 'memory.search', authorizedCorpusEmpty: true, revision: retrieval.authorizedCorpusRevision });
        tools.push(current.name); continue;
      }
      let facts: unknown = current.name === 'memory.search' ? memorySearchFacts(result) : result;
      if (worldQuery) {
        const knowledge = record(result.worldKnowledge);
        if (!knowledge || !Array.isArray(knowledge.items)) return;
        // The generated evidence message is a receipt of the same observation,
        // not a changed fact. Real item IDs, source versions and content stay.
        const { evidenceMessageId: _receipt, ...visible } = knowledge; void _receipt;
        facts = visible;
      }
      queries.push(canonical({ name: worldQuery ? 'world.query' : current.name, args: worldQuery ? { ...args, action: undefined } : args, facts }));
      tools.push(current.name);
    } catch { return; }
  }
  return { digest: createHash('sha256').update(JSON.stringify(queries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))).digest('hex'),
    tools: [...new Set(tools)].sort(), ...(allEmptyCorpus ? { kind: 'empty_authorized_memory' as const } : {}) };
}
function requests(turn: CompanionLoopTurn): string | undefined {
  if (!turn.calls.length) return;
  const queries: unknown[] = [];
  for (const call of turn.calls) {
    try {
      const current = normalized(call), args = record(JSON.parse(current.arguments));
      if (!args) return;
      const world = current.name === 'memory.world_query' || current.name === 'world' && args.action === 'query';
      if (!world && current.name !== 'memory.search' && current.name !== 'memory.read') return;
      queries.push(canonical({ name: world ? 'world.query' : current.name, args: world ? { ...args, action: undefined } : args }));
    } catch { return; }
  }
  return JSON.stringify(queries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}
/** With no trustworthy new host epoch, an unchanged seventh read is not
 * dispatched merely because a process restarted. A different decision may run. */
export function companionAgentRepeatsObservation(candidate: CompanionLoopTurn, previous: CompanionLoopTurn): boolean {
  const key = requests(candidate); return key !== undefined && key === requests(previous);
}
/** Six unchanged successful observation turns, not a lifetime reasoning cap.
 * Any different query/cursor, factual version/content or effect resets it. */
export function companionAgentNoProgress(turns: readonly CompanionLoopTurn[], fromStep = 0): CompanionAgentNoProgressProof | undefined {
  if (turns.length - fromStep < 6) return;
  const start = turns.length - 6, observations = turns.slice(start).map(observation);
  const first = observations[0];
  if (!first || observations.some(value => !value || value.digest !== first.digest)) return;
  return { fromStep: start, throughStep: turns.length - 1, repetitions: 6, observationDigest: first.digest, tools: first.tools, ...(first.kind ? { kind: first.kind } : {}) };
}
