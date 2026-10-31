import type { CompanionLoopTurn } from '../../shared/companion-loop';
import { companionMemoryProcedureContextListSchema } from '../../shared/companion-procedure';
import { companionProcedureContextSources } from './memory-procedure-context';
import { companionMemorySelectionSchema } from '../../shared/companion-memory-selection';
import { companionMemoryArtifactKindSchema, companionMemoryRetrievalScopeSchema, COMPANION_MEMORY_SCOPE_MEANINGS } from '../../shared/companion-memory-scope';

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
  const type = object(receipt.typeScope), scope = companionMemoryRetrievalScopeSchema.safeParse(type?.consumer);
  const selection = companionMemorySelectionSchema.safeParse(receipt.selection);
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
    const kind = companionMemoryArtifactKindSchema.safeParse(reference.artifactKind);
    return [{ id: reference.id, ...(kind.success ? { artifactKind: kind.data } : {}), ...(typeof reference.version === 'number' ? { version: reference.version } : {}), role: reference.role,
      ...(sources ? { sources } : {}) }];
  }) : undefined;
  return { text: receipt.text, ...(scope.success ? { typeScope: { consumer: scope.data, meaning: COMPANION_MEMORY_SCOPE_MEANINGS[scope.data] } } : {}),
    ...(selection.success ? { selection: selection.data } : {}), ...(proceduralStatus?.length ? { proceduralStatus,
    proceduralStatusMeaning: '宿主核验的方法状态：unverified只代表读过、尚无客观试验证据；validated只支持相应适用条件下的实际交付验证，不代表全面熟练；disabled表示有实际失败反证。方法步骤和适用限制仅以本任务系统已提供的内容为准，缺失时不补造。' } : {}), ...(evidence ? { evidence: {
    ...(evidence.queryClock ? { queryClock: evidence.queryClock } : {}),
    ...(references ? { references } : {}),
    ...(evidence.referenceCoverage ? { referenceCoverage: evidence.referenceCoverage } : {}),
  } } : {}) };
}

/** Only these reserved top-level host fields are projected. User prose, note
 * metadata and nested objects resembling a receipt remain byte-for-byte data. */
function projectPayload(data: Record<string, unknown>, search = false): Record<string, unknown> {
  const recall = object(data.memoryRecall);
  const projected = { ...data };
  if (data.memorySelection !== undefined) {
    const selection = companionMemorySelectionSchema.safeParse(data.memorySelection);
    if (selection.success) projected.memorySelection = selection.data;
    else delete projected.memorySelection;
  }
  if (recall) {
    const { timings: _timings, continuation: _continuation, ...visible } = recall; void _timings; void _continuation;
    projected.memoryRecall = { ...visible, ...(recall.context ? { context: memoryReceipt(recall.context) } : {}) };
  }
  if (data.memoryContext !== undefined) projected.memoryContext = memoryReceipt(data.memoryContext);
  const typedNote = (value: unknown): unknown => {
    const note = object(value), kind = companionMemoryArtifactKindSchema.safeParse(note?.artifactKind);
    if (!note || !kind.success) return value;
    const meaning = kind.data === 'self_understanding' ? COMPANION_MEMORY_SCOPE_MEANINGS.self : kind.data === 'dream_fiction' ? COMPANION_MEMORY_SCOPE_MEANINGS.dream
      : kind.data === 'navigation' ? COMPANION_MEMORY_SCOPE_MEANINGS.navigation : kind.data === 'knowledge' ? COMPANION_MEMORY_SCOPE_MEANINGS.knowledge
        : kind.data === 'procedure' ? COMPANION_MEMORY_SCOPE_MEANINGS.procedures : COMPANION_MEMORY_SCOPE_MEANINGS.episodes;
    return { ...note, typeMeaning: meaning };
  };
  if (Array.isArray(data.memories)) projected.memories = data.memories.map(typedNote);
  const read = object(data.memoryRead);
  if (read) projected.memoryRead = { ...read, memory: typedNote(read.memory), ...(Array.isArray(read.related) ? { related: read.related.map(typedNote) } : {}) };
  const page = object(data.memoryPage);
  if (page && Array.isArray(page.items)) projected.memoryPage = { ...page, items: page.items.map(value => {
    const hit = object(value), note = hit && object(hit.memory), context = object(data.memoryContext);
    // The native formatter already supplies the search's observed text. Keep
    // its historical candidate directory, without injecting
    // every full candidate and its copied source evidence a second time. A
    // browse (no formatter) and an explicit read retain their complete bodies.
    if (search && note && context && typeof context.text === 'string'
      && typeof context.revision === 'string' && typeof context.profileKey === 'string') {
      const candidate = Object.fromEntries(['id', 'version', 'contentRevision', 'artifactKind', 'diaryName', 'tags', 'occurredAt', 'createdAt', 'updatedAt', 'origin', 'status']
        .filter(key => note[key] !== undefined).map(key => [key, note[key]]));
      return { ...hit, memory: typedNote(candidate), bodyAvailability: 'candidate_directory_only' };
    }
    return hit ? { ...hit, memory: typedNote(hit.memory) } : value;
  }) };
  const retrieval = object(data.memoryRetrieval);
  if (retrieval) {
    // Stage explanations, scores and duplicate excerpts feed the inspection
    // panel. They are not additional facts for every subsequent model turn.
    projected.memoryRetrieval = Object.fromEntries(['mode', 'engine', 'resultCount', 'candidateQuerySeparateFromContext', 'publicationView', 'authorizedCorpusEmpty']
      .filter(key => retrieval[key] !== undefined).map(key => [key, retrieval[key]]));
  }
  delete projected.memorySearchTimings;
  return projected;
}

export function projectCompanionMemoryContextForModel(context: { system: string; user: string }): { system: string; user: string } {
  let data: unknown;
  try { data = JSON.parse(context.user); } catch { return context; }
  const payload = object(data);
  if (!payload || !payload.memoryRecall && payload.memoryContext === undefined && payload.memorySearchTimings === undefined && payload.memorySelection === undefined
    && !Array.isArray(payload.memories) && !payload.memoryRead && !payload.memoryPage) return context;
  return { system: context.system, user: JSON.stringify(projectPayload(payload)) };
}

/** Tool results are projected only for a real memory capability's matching
 * call/result pair, after host evidence checks have consumed the raw turns. */
export function projectCompanionMemoryToolTurnsForModel(turns: readonly CompanionLoopTurn[]): readonly CompanionLoopTurn[] {
  return turns.map(turn => {
    if (!turn.results?.length) return turn;
    const memoryCalls = new Map(turn.calls.filter(call => call.name === 'memory' || call.name.startsWith('memory.')).map(call => [call.id, call]));
    if (!memoryCalls.size) return turn;
    return { ...turn, results: turn.results.map(result => {
      if (!memoryCalls.has(result.callId)) return result;
      let value: unknown;
      try { value = JSON.parse(result.content); } catch { return result; }
      const payload = object(value);
      if (!payload || payload.memoryContext === undefined && payload.memoryRecall === undefined && payload.memorySearchTimings === undefined && payload.memorySelection === undefined
        && !Array.isArray(payload.memories) && !payload.memoryRead && !payload.memoryPage) return result;
      const call = memoryCalls.get(result.callId)!;
      let search = call.name === 'memory.search';
      if (call.name === 'memory') try { search = object(JSON.parse(call.arguments))?.action === 'search'; } catch { /* Invalid arguments are not a search. */ }
      return { ...result, content: JSON.stringify(projectPayload(payload, search)) };
    }) };
  });
}
