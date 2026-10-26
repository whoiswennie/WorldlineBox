import { createHash } from 'node:crypto';
import type { CompanionAgentRun } from '../../shared/companion-agent-run';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionReplyInput } from './context';
import { companionKnowledgeReads, verifyCompanionKnowledgeReads } from './knowledge-evidence';
import { companionMemoryContextDependencies } from './memory-context-evidence';
import { captureCompanionExecutionReadset } from './execution-evidence';
import { buildCompanionContext } from './context';

export interface CompanionAgentJournal {
  load(frame: CompanionReplyInput, domain: { system: string; user: string }): Promise<CompanionAgentRun>;
  save(run: CompanionAgentRun): Promise<void>;
  valid(run: CompanionAgentRun): Promise<boolean>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const companionAgentRunIdentity = (companionId: string, conversationId: string, invocationId: string): string => hash([companionId, conversationId, invocationId]);

/** Source-bearing job/round IDs stay stable across a lease retry. The journal
 * keeps actual tool decisions and receipts, separate from published speech. */
export function companionAgentJournal(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>): CompanionAgentJournal {
  const boundaries = new Map<string, number | undefined>();
  const checked = async (command: CompanionStorageCommand) => {
    const result = await request(command);
    if (!result.ok) throw new Error(result.error ?? '伙伴推理检查点不可用。');
    return result;
  };
  return {
    async load(frame, domain) {
      const invocation = frame.invocation;
      if (!invocation) throw new Error('持久推理必须绑定实际任务。');
      const id = companionAgentRunIdentity(frame.companion.id, frame.conversation.id, invocation.id);
      boundaries.set(id, frame.contextThroughSequence ?? frame.sourceMessage?.sequence);
      const requestDigest = hash([invocation.kind, invocation.goal, invocation.authorization,
        (JSON.parse(domain.user) as { purpose?: string }).purpose]);
      const previous = (await checked({ type: 'agent.run.get', companionId: frame.companion.id, id })).agentRun;
      if (previous) {
        if (previous.requestDigest !== requestDigest || previous.topicId !== invocation.topicId) throw new Error('同一持久推理端口不能替换目标、授权或话题。');
        if (!await verifyCompanionKnowledgeReads(previous.knowledgeReads, { companionId: previous.companionId, conversationId: previous.conversationId, beforeSequence: boundaries.get(id) }, request))
          throw new Error('推理使用的冷知识资料或授权已变化，旧步骤不能恢复。');
        return previous;
      }
      const sources = [...new Map([...(frame.messages ?? []), ...(frame.sourceMessage ? [frame.sourceMessage] : [])]
        .filter(message => message.status === 'sent' && !message.isReplyDraft)
        .map(message => [message.id, { id: message.id, conversationId: message.conversationId,
          checksum: createHash('sha256').update(message.content).digest('hex') }])).values()];
      // With native context, context.ts suppresses raw candidate bodies. Bind
      // only the formatter output / actual focusing input that was observed;
      // the independent candidate ranks are not evidence that a note was read.
      const context = frame.memoryRecall?.context;
      const dependencies = context ? companionMemoryContextDependencies(context) : undefined;
      const memories = dependencies?.frozenMemories ? [] : dependencies?.memories ?? frame.memories.map(note => ({ id: note.id, version: note.version }));
      return { id, companionId: frame.companion.id, conversationId: frame.conversation.id, invocationId: invocation.id,
        topicId: invocation.topicId, requestDigest, revision: 0, status: 'running', turns: [], sources,
        memories: [...new Map(memories.map(note => [`${note.id}:${note.version}`, note])).values()], effects: [],
        ...(dependencies?.frozenMemories ? { frozenMemories: dependencies.frozenMemories } : {}),
        ...(frame.memoryRecall ? { passiveRecall: { prepared: true as const, ...(context ? { context } : {}) } } : {}),
        topics: captureCompanionExecutionReadset({ companionId: frame.companion.id, conversationId: frame.conversation.id },
          { context: buildCompanionContext(frame) }).topics };
    },
    async save(run) {
      if (!await verifyCompanionKnowledgeReads(run.knowledgeReads, { companionId: run.companionId, conversationId: run.conversationId, beforeSequence: boundaries.get(run.id) }, request))
        throw new Error('推理使用的冷知识资料或授权已变化，不能保存旧步骤。');
      const revision = run.revision;
      const next = { ...run, revision: revision + 1 };
      await checked({ type: 'agent.run.save', run: next, expectedRevision: revision });
      run.revision = next.revision;
    },
    async valid(run) {
      try {
        if (!await verifyCompanionKnowledgeReads(run.knowledgeReads, { companionId: run.companionId, conversationId: run.conversationId, beforeSequence: boundaries.get(run.id) }, request)) return false;
        const current = (await checked({ type: 'agent.run.get', companionId: run.companionId, id: run.id })).agentRun;
        return !current ? run.revision === 0 : current.revision === run.revision;
      } catch { return false; }
    },
  };
}

/** Record exactly the formal note versions actually returned by a tool. This
 * does not treat candidates as quotations or turn them into new authority. */
export function captureCompanionAgentMemories(run: CompanionAgentRun, value: unknown): void {
  // Only a successful host tool envelope can introduce a cold receipt. We do
  // not parse user text as JSON or recognize a nested user-supplied envelope.
  for (const read of companionKnowledgeReads(value)) {
    const reads = run.knowledgeReads ??= [];
    if (!reads.some(current => current.id === read.id && current.version === read.version)) reads.push(read);
    if (read.sourceType === 'memory') {
      const version = Number(read.sourceVersion);
      if (!run.memories.some(note => note.id === read.sourceId && note.version === version)) run.memories.push({ id: read.sourceId, version });
    } else if (read.sourceType === 'message' && !run.sources.some(source => source.id === read.sourceId && source.checksum === read.sourceDigest)) {
      run.sources.push({ id: read.sourceId, conversationId: read.conversationId, checksum: read.sourceDigest });
    }
  }
  captureFormalMemoryObjects(run, value);
}
function captureFormalMemoryObjects(run: CompanionAgentRun, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (data.ok !== true) return;
  const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const note = (value: unknown) => {
    const saved = record(value);
    if (saved?.companionId !== run.companionId || typeof saved.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(saved.id)
      || !Number.isSafeInteger(saved.version) || Number(saved.version) < 1 || typeof saved.content !== 'string' || !Array.isArray(saved.sources)) return;
    if (!run.memories.some(note => note.id === saved.id && note.version === saved.version)) run.memories.push({ id: saved.id, version: saved.version as number });
  };
  if (Array.isArray(data.memories)) data.memories.forEach(note);
  const read = record(data.memoryRead); note(read?.memory); if (Array.isArray(read?.related)) read.related.forEach(note);
  const page = record(data.memoryPage); if (Array.isArray(page?.items)) page.items.forEach(item => note(record(item)?.memory));
  for (const memory of companionMemoryContextDependencies(data.memoryContext).memories)
    if (!run.memories.some(note => note.id === memory.id && note.version === memory.version)) run.memories.push(memory);
}
