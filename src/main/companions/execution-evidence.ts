import { createHash } from 'node:crypto';
import { z } from 'zod';
import { companionExecutionReadsetSchema, type CompanionExecutionReadset } from '../../shared/companion-execution-evidence';
import type { CompanionLoopTurn } from '../../shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { normalizeCompanionCapabilityCall } from '../../shared/companion-capability-tools';
import { companionKnowledgeReads, verifyCompanionKnowledgeReads } from './knowledge-evidence';
import { socialProgressReads } from './social-progress-evidence';
import { companionMemoryContextDependencies } from './memory-context-evidence';
import { companionWorldSourceReadSchema } from '../../shared/companion-world';
import { companionSocialGameContextSchema } from '../../shared/companion-social';

type Scope = Pick<CompanionExecutionReadset, 'companionId' | 'conversationId' | 'beforeSequence'>;
type Fields = Pick<CompanionExecutionReadset, 'memories' | 'sources' | 'knowledgeReads' | 'contexts' | 'topics'>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const row = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const entries = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const unique = <T>(values: T[]): T[] => [...new Map(values.map(value => [JSON.stringify(value), value])).values()]
  .sort((left, right) => { const a = JSON.stringify(left), b = JSON.stringify(right); return a < b ? -1 : a > b ? 1 : 0; });
const sourceBody = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), conversationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), content: z.string() });

/** Host world quotes name their actual message dependencies. Free JSON in
 * topic state, note metadata or native task output never contributes IDs. */
export function companionWorldReadSourceIds(input: { context?: { user: string }; turns?: readonly CompanionLoopTurn[] }): string[] {
  const ids = new Set<string>(), add = (value: unknown) => { if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(value)) ids.add(value); };
  const world = (value: unknown) => {
    const snapshot = row(value);
    for (const event of entries(snapshot?.events)) add(row(event)?.sourceMessageId);
    for (const event of entries(snapshot?.events)) for (const read of entries(row(event)?.sourceReads)) add(row(read)?.id);
    for (const visit of entries(snapshot?.visits)) { add(row(visit)?.sourceMessageId); add(row(visit)?.responseSourceMessageId); }
  };
  try { world(row(JSON.parse(input.context?.user ?? '{}'))?.world); } catch { /* No typed host context. */ }
  for (const turn of input.turns ?? []) for (const call of turn.calls) {
    try {
      if (normalizeCompanionCapabilityCall(call).name !== 'world') continue;
      const result = turn.results?.find(result => result.callId === call.id);
      const receipt = result && row(JSON.parse(result.content));
      if (!receipt || receipt.ok !== true) continue;
      world(receipt.world); add(row(receipt.worldKnowledge)?.evidenceMessageId);
    } catch { /* Unmatched and untyped output is not a world source read. */ }
  }
  return [...ids];
}

/** Known host world ports carry the checksums of the bytes the model actually
 * consumed. Never refresh an old quotation's proof with a newer source body. */
export function companionWorldReadSources(input: { context?: { user: string }; turns?: readonly CompanionLoopTurn[] }): {
  sources: CompanionExecutionReadset['sources']; complete: boolean;
} {
  const sources: CompanionExecutionReadset['sources'] = []; let complete = true;
  const add = (value: unknown, id?: unknown, conversationId?: unknown) => {
    const parsed = companionWorldSourceReadSchema.safeParse(value);
    if (!parsed.success || id !== undefined && parsed.data.id !== id || conversationId !== undefined && parsed.data.conversationId !== conversationId) { complete = false; return; }
    sources.push(parsed.data);
  };
  const world = (value: unknown) => {
    const snapshot = row(value);
    for (const value of entries(snapshot?.events)) {
      const event = row(value), reads = entries(event?.sourceReads);
      for (const read of reads) add(read);
      if (event?.sourceMessageId !== undefined && !reads.some(read => row(read)?.id === event.sourceMessageId && row(read)?.conversationId === event.conversationId)) complete = false;
    }
    for (const value of entries(snapshot?.visits)) {
      const visit = row(value);
      if (visit?.sourceMessageId !== undefined) add(visit.sourceRead, visit.sourceMessageId, visit.conversationId);
      if (visit?.responseSourceMessageId !== undefined) add(visit.responseSourceRead, visit.responseSourceMessageId, visit.responseConversationId);
    }
  };
  try { world(row(JSON.parse(input.context?.user ?? '{}'))?.world); } catch { complete = false; }
  for (const turn of input.turns ?? []) for (const call of turn.calls) {
    try {
      if (normalizeCompanionCapabilityCall(call).name !== 'world') continue;
      const result = turn.results?.find(result => result.callId === call.id), receipt = result && row(JSON.parse(result.content));
      if (!receipt || receipt.ok !== true) continue;
      world(receipt.world);
      const evidenceId = row(receipt.worldKnowledge)?.evidenceMessageId;
      if (evidenceId !== undefined) {
        const body = sourceBody.safeParse(entries(receipt.memorySources).find(value => row(value)?.id === evidenceId));
        if (body.success) sources.push({ id: body.data.id, conversationId: body.data.conversationId, checksum: hash(body.data.content) });
        else complete = false;
      }
    } catch { /* Unmatched/untyped public errors establish no reads. */ }
  }
  return { sources: unique(sources), complete };
}

/** Capture the host's actual inference inputs. Native DSH output and arbitrary
 * nested source JSON never introduce evidence or authorization. */
export function captureCompanionExecutionReadset(scope: Scope, input: Partial<Fields> & {
  context?: { user: string }; turns?: readonly CompanionLoopTurn[]; readsets?: readonly CompanionExecutionReadset[];
} = {}): CompanionExecutionReadset {
  const result: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', ...scope, complete: true,
    memories: [...input.memories ?? []], sources: [...input.sources ?? []], knowledgeReads: [...input.knowledgeReads ?? []], contexts: [...input.contexts ?? []], topics: [...input.topics ?? []] };
  const source = (value: unknown, fallbackRoom?: string) => {
    if (value === undefined) return;
    const item = row(value);
    const parsed = sourceBody.safeParse(item && item.conversationId === undefined && fallbackRoom ? { ...item, conversationId: fallbackRoom } : value);
    if (parsed.success) result.sources.push({ id: parsed.data.id, conversationId: parsed.data.conversationId, checksum: hash(parsed.data.content) });
    else result.complete = false;
  };
  const memory = (value: unknown) => {
    const note = row(value);
    if (note?.companionId !== scope.companionId || typeof note.content !== 'string') return;
    // The full note has other fields; validate only the actual reference.
    const reference = companionExecutionReadsetSchema.shape.memories.element.safeParse({ id: note.id, version: note.version });
    if (reference.success) result.memories.push(reference.data);
    else result.complete = false;
  };
  const context = (value: unknown) => {
    const native = row(value);
    if (!native || typeof native.text !== 'string') return;
    const dependencies = companionMemoryContextDependencies(native);
    result.memories.push(...dependencies.memories);
    if (dependencies.malformed) result.complete = false;
    if (dependencies.complete) return;
    const evidence = row(native.evidence);
    const parsed = companionExecutionReadsetSchema.shape.contexts.element.safeParse({ revision: native.revision, profileKey: native.profileKey,
      ...(evidence?.beforeSequence !== undefined ? { beforeSequence: evidence.beforeSequence } : scope.beforeSequence !== undefined ? { beforeSequence: scope.beforeSequence } : {}) });
    if (!parsed.success) { result.complete = false; return; }
    result.contexts.push(parsed.data);
    // Unknown partial/legacy inputs retain their conservative corpus guard.
    // Complete host closures above validate immutable source versions instead.
  };
  const topic = (value: unknown, metadata: unknown) => {
    const state = row(value);
    if (!state || state.readerId !== scope.companionId) return;
    const info = row(metadata), checkpointEventIds: string[] = [], sourceMessageIds: string[] = [];
    const hasCheckpoint = !!state.shared || !!state.workingState;
    if (!hasCheckpoint) return;
    if (!info || info.id !== state.topicId || typeof info.conversationId !== 'string') { result.complete = false; return; }
    for (const value of [state.shared, state.workingState]) {
      const part = row(value), checksums = row(part?.sourceChecksums);
      if (!part) continue;
      if (typeof part.sourceEventId !== 'string') result.complete = false; else checkpointEventIds.push(part.sourceEventId);
      for (const id of entries(part?.sourceMessageIds)) {
        const parsed = companionExecutionReadsetSchema.shape.sources.element.safeParse({ id, conversationId: info.conversationId, checksum: typeof id === 'string' ? checksums?.[id] : undefined });
        // Reading an authorized checkpoint does not grant its original chat
        // window. The immutable topic DAG verifies these bytes under checkpoint
        // ACL (including late invitees), independently of actual raw reads.
        if (parsed.success) sourceMessageIds.push(parsed.data.id); else result.complete = false;
      }
    }
    const reference = companionExecutionReadsetSchema.shape.topics.element.safeParse({ conversationId: info.conversationId, topicId: info.id,
      checkpointEventIds: [...new Set(checkpointEventIds)], sourceMessageIds: [...new Set(sourceMessageIds)] });
    if (reference.success) result.topics.push(reference.data); else result.complete = false;
  };
  if (input.context) {
    try {
      const data = row(JSON.parse(input.context.user));
      if (!data) result.complete = false;
      else {
        // Some saved host context rows omit their redundant room. Only this
        // direct dialogue port may inherit the verified host entrance; never
        // infer another tool/source room from message prose or arbitrary JSON.
        const hostRoom = row(data.conversation)?.id ?? row(data.invocation)?.conversationId;
        const dialogueRoom = hostRoom === scope.conversationId ? scope.conversationId : undefined;
        entries(data.messages).forEach(value => source(value, dialogueRoom)); entries(data.memorySources).forEach(value => source(value)); entries(data.memories).forEach(memory);
        if (data.topicPublicationReference !== undefined) {
          const reference = row(data.topicPublicationReference), message = row(reference?.message), metadata = row(data.topic);
          const derived = metadata?.lastNarrativePublicationAvailability !== undefined;
          const pointer = row(derived ? metadata?.lastNarrativePublicationRef : metadata?.lastPublicationRef);
          const parsed = sourceBody.safeParse(message);
          if (!reference || !metadata || !parsed.success || metadata.kind !== 'story' || metadata.id !== message?.topicId
            || metadata.conversationId !== scope.conversationId || parsed.data.conversationId !== scope.conversationId
            || reference.formalPublicationRevision !== (metadata.formalPublicationRevision ?? 0)
            || (derived ? metadata.lastNarrativePublicationAvailability : metadata.lastPublicationAvailability) !== 'available' || pointer?.messageId !== parsed.data.id
            || derived && (!Number.isSafeInteger(pointer?.publicationRevision) || Number(pointer?.publicationRevision) < 1
              || Number(pointer?.publicationRevision) > Number(metadata.formalPublicationRevision))
            || pointer.authorId !== message?.authorId || pointer.contentChecksum !== reference.contentChecksum
            || !Number.isSafeInteger(reference.formalPublicationRevision) || Number(reference.formalPublicationRevision) < 0
            || message?.authorId === 'user' || message?.authorId === 'system' || typeof message?.authorId !== 'string'
            || message.status !== 'sent' || message.isReplyDraft || message.replyDraft
            || reference.contentChecksum !== hash(parsed.data.content)) result.complete = false;
          else source(parsed.data);
        }
        context(row(data.memoryRecall)?.context); topic(data.topicState, data.topic);
        if (data.gameCommunication !== undefined) {
          const game = companionSocialGameContextSchema.safeParse(data.gameCommunication);
          if (!game.success || game.data.binding.companionId !== scope.companionId
            || game.data.binding.sourceConversationId !== scope.conversationId) result.complete = false;
          else topic(game.data.topicState, game.data.topic);
        }
        source(row(data.taskRequest)?.replyReference, dialogueRoom);
        for (const value of entries(data.currentGoalReplies)) {
          const goal = row(value), origins = entries(goal?.origins).map(row).filter(origin => !!origin);
          for (const value of entries(goal?.messages)) {
            const message = row(value);
            if (message && origins.some(origin => origin?.messageId === message.id && origin.conversationId === message.conversationId
              && origin.topicId === message.topicId)) source(message);
          }
        }
      }
    } catch { result.complete = false; }
  }
  for (const turn of input.turns ?? []) for (const call of turn.calls) {
    try {
      const name = normalizeCompanionCapabilityCall(call).name;
      const receipt = turn.results?.find(result => result.callId === call.id);
      if (!receipt || !(name.startsWith('memory.') || ['history', 'topic', 'world', 'experience'].includes(name))) continue;
      const data = row(JSON.parse(receipt.content));
      if (!data || data.ok === false) continue;
      if (name === 'history') entries(data.messages).forEach(value => source(value));
      else if (name === 'experience') {
        // Only the matched owner-bound host receipt supplies provenance;
        // renamed titles and arbitrary nested metadata confer none.
        if (data.experienceEvidence !== undefined) {
          const parsed = companionExecutionReadsetSchema.safeParse(data.experienceEvidence);
          if (!parsed.success || parsed.data.companionId !== scope.companionId || parsed.data.conversationId !== scope.conversationId) result.complete = false;
          else { const proof = parsed.data; result.complete &&= proof.complete;
            result.memories.push(...proof.memories); result.sources.push(...proof.sources); result.knowledgeReads.push(...proof.knowledgeReads);
            result.contexts.push(...proof.contexts); result.topics.push(...proof.topics); }
        }
      }
      else if (name === 'topic') topic(data.topicState, data.topic);
      else if (name === 'world') { entries(data.memorySources).forEach(value => source(value)); topic(data.topicState, data.topic); }
      else if (data.ok === true) {
        context(data.memoryContext);
        for (const item of entries(row(data.memoryPage)?.items)) memory(row(item)?.memory);
        const read = row(data.memoryRead);
        memory(read?.memory); entries(read?.related).forEach(memory); entries(read?.sources).forEach(value => source(value));
        entries(data.memories).forEach(memory); entries(data.memorySources).forEach(value => source(value));
        result.knowledgeReads.push(...companionKnowledgeReads(data));
      }
    } catch { /* Public textual errors and malformed legacy records confer no evidence. */ }
  }
  // Delegated reply bodies are available only through the typed progress
  // receipt and its matching origin ledger, never arbitrary peer/DSH JSON.
  for (const message of socialProgressReads(input.turns ?? []).values()) source(message);
  for (const previous of input.readsets ?? []) {
    const parsed = companionExecutionReadsetSchema.safeParse(previous);
    if (!parsed.success || previous.companionId !== scope.companionId || previous.conversationId !== scope.conversationId) { result.complete = false; continue; }
    result.complete &&= previous.complete;
    result.memories.push(...previous.memories); result.sources.push(...previous.sources);
    result.knowledgeReads.push(...previous.knowledgeReads); result.contexts.push(...previous.contexts);
    result.topics.push(...previous.topics);
  }
  return companionExecutionReadsetSchema.parse({ ...result, memories: unique(result.memories), sources: unique(result.sources),
    knowledgeReads: unique(result.knowledgeReads), contexts: unique(result.contexts), topics: unique(result.topics) });
}

/** Stable proof for a small native recordScope; full references stay in the
 * owner-controlled action checkpoint, never the model task specification. */
export function companionExecutionReadsetDigest(value: CompanionExecutionReadset): string {
  const parsed = companionExecutionReadsetSchema.parse(value);
  return hash(JSON.stringify({ ...parsed, memories: unique(parsed.memories), sources: unique(parsed.sources),
    knowledgeReads: unique(parsed.knowledgeReads), contexts: unique(parsed.contexts), topics: unique(parsed.topics) }));
}

export async function verifyCompanionExecutionReadset(value: CompanionExecutionReadset | undefined, scope: Scope, ports: {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  contextValid?(scope: Scope, context: { revision: string; profileKey: string }): Promise<boolean>;
  /** Ephemeral Main-only proof of this exact readset from the current worker
   * response. Callers must bind its digest and mutation generation; never
   * derive it from model/tool JSON or a persisted historical receipt. */
  sqliteSourcesValidated?: boolean;
}): Promise<boolean> {
  try {
    const parsed = companionExecutionReadsetSchema.safeParse(value);
    if (!parsed.success || !parsed.data.complete || parsed.data.companionId !== scope.companionId || parsed.data.conversationId !== scope.conversationId
      || scope.beforeSequence !== undefined && parsed.data.beforeSequence !== scope.beforeSequence) return false;
    const readset = parsed.data, memoryScope = { companionId: readset.companionId, conversationId: readset.conversationId, beforeSequence: readset.beforeSequence };
    if (!ports.sqliteSourcesValidated) {
    for (const reference of readset.topics) {
      for (let offset = 0; offset < Math.max(1, reference.sourceMessageIds.length); offset += 256) {
        const checked = await ports.request({ type: 'topic.sources.valid', conversationId: reference.conversationId, topicId: reference.topicId,
          readerId: readset.companionId, sourceMessageIds: reference.sourceMessageIds.slice(offset, offset + 256), checkpointEventIds: reference.checkpointEventIds });
        if (!checked.ok || !checked.topicSourcesValid) return false;
      }
    }
    for (let offset = 0; offset < readset.memories.length; offset += 100) {
      const expected = readset.memories.slice(offset, offset + 100);
      const response = await ports.request({ type: 'memory.records.filter', ...memoryScope, ids: [...new Set(expected.map(memory => memory.id))] });
      if (!response.ok || expected.some(memory => !response.memories?.some(current => current.id === memory.id && current.companionId === scope.companionId && current.version === memory.version))) return false;
    }
    const rooms = new Set(readset.sources.map(source => source.conversationId));
    for (const conversationId of rooms) {
      const sources = readset.sources.filter(source => source.conversationId === conversationId);
      for (let offset = 0; offset < sources.length; offset += 100) {
        const expected = sources.slice(offset, offset + 100);
        // Exact host-issued reads can include a fresh observation receipt after
        // the dialogue cursor. Recheck these known IDs against current ACL and
        // bytes, without mistaking them for an enlarged recent-chat window.
        const response = await ports.request({ type: 'memory.sources.filter', companionId: readset.companionId, conversationId, ids: [...new Set(expected.map(source => source.id))] });
        if (!response.ok || expected.some(source => !response.memorySources?.some(current => current.id === source.id && current.conversationId === conversationId && hash(current.content) === source.checksum))) return false;
      }
    }
    }
    for (const context of readset.contexts) if (!ports.contextValid || !await ports.contextValid({ ...memoryScope, beforeSequence: context.beforeSequence }, context)) return false;
    return await verifyCompanionKnowledgeReads(readset.knowledgeReads, memoryScope, ports.request);
  } catch { return false; }
}

/** An invalid derived reply never erases what actually executed. Preserve only
 * typed effect identity/status and numeric statistics, withholding all reusable
 * text, artifact paths, structured payloads, sessions and resume affordances. */
export function projectCompanionExecutionReceipt(value: Record<string, unknown>, valid: boolean): Record<string, unknown> {
  if (valid) return value;
  const statistics = row(value.statistics);
  return { ...(typeof value.id === 'string' ? { id: value.id } : {}), ...(typeof value.recordId === 'string' ? { recordId: value.recordId } : {}),
    ...(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(value.status)) ? { status: value.status } : {}),
    ...(statistics ? { statistics: Object.fromEntries(['turns', 'steps', 'toolCalls', 'durationMs', 'recordCount'].map(key => [key,
      typeof statistics[key] === 'number' && Number.isFinite(statistics[key]) && statistics[key] >= 0 ? statistics[key] : null])) } : {}),
    contentAvailable: false, resumeAllowed: false, reason: 'execution_source_changed', trust: 'host_actual_effect_state_without_withdrawn_content' };
}
