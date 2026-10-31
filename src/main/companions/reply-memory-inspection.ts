import type { z } from 'zod';
import type { CompanionMemory, CompanionMessage } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { companionReplyMemoryCommand, CompanionReplyMemory } from '../../shared/companion-reply-memory';
import { recallCorpusHash } from './recall-evidence';
import { createHash } from 'node:crypto';
import type { CompanionSocialReplyMemoryRequest, CompanionSocialReplyReceipt } from '../../shared/companion-social-reply';
import { companionMemoryContextDependencies } from './memory-context-evidence';

type Request = z.infer<typeof companionReplyMemoryCommand>;
type Transport = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
type SavedContext = { taskRequest?: { sourceMessageId?: string; prompt?: string }; memories?: Array<{ id: string; version: number }>; memoryRecall?: {
  reasons?: Array<{ id: string; version?: number }>;
  pending?: boolean; degraded?: boolean; continuation?: { query?: { query?: string } };
  context?: { text: string; revision: string; evidence?: { capturedAt: string; corpusHash: string; beforeSequence?: number } };
} };

const emptyReceipt = (input: Pick<Request, 'companionId' | 'conversationId' | 'messageId'>): CompanionReplyMemory => ({ companionId: input.companionId, conversationId: input.conversationId,
    messageId: input.messageId, observedAt: new Date().toISOString(), state: 'unavailable', contextCharacters: 0,
    contextOffset: 0, contextTruncated: false, candidates: [], pending: false, degraded: false,
    explanation: '这条回复没有保存可查看的召回详情。历史记录不会补造召回内容。' });
/** Inspect the saved native result, never rerun retrieval or initialize a model. */
export async function inspectCompanionReplyMemory(input: Request, request: Transport): Promise<CompanionReplyMemory> {
  const base = emptyReceipt(input);
  const message = (await request({ type: 'message.get', id: input.messageId })).message;
  if (!message || message.authorId !== input.companionId || message.conversationId !== input.conversationId) return base;
  const loop = (await request({ type: 'loop.for-message', messageId: input.messageId })).loop;
  const social = !loop ? (await request({ type: 'social.reply.for-message', messageId: input.messageId })).socialReplyReceipt : undefined;
  const checkpoint = loop ?? social;
  return inspectSavedRecall(input, checkpoint, request, base, social?.sourceChecksum);
}

/** Pending target IDs are job IDs, never synthetic messages or learning sources. */
export async function inspectCompanionSocialReplyMemory(input: CompanionSocialReplyMemoryRequest, request: Transport): Promise<CompanionReplyMemory> {
  const target = { ...input, messageId: input.jobId }, base = { ...emptyReceipt(target),
    explanation: '这轮伙伴回应尚未完成回忆，或该次任务已经结束、取消或进入重试。此标识是任务，不是正式消息。' };
  const checkpoint = (await request({ type: 'social.reply.for-job', jobId: input.jobId })).socialReplyReceipt;
  return inspectSavedRecall(target, checkpoint, request, base, checkpoint?.sourceChecksum, async () => {
    const current = (await request({ type: 'social.reply.for-job', jobId: input.jobId })).socialReplyReceipt;
    return !!current && current.companionId === checkpoint?.companionId && current.conversationId === checkpoint.conversationId
      && !!checkpoint.leaseToken && current.leaseToken === checkpoint.leaseToken
      && current.sourceChecksum === checkpoint.sourceChecksum && current.context.user === checkpoint.context.user;
  });
}

type Checkpoint = Pick<CompanionSocialReplyReceipt, 'companionId' | 'conversationId' | 'sourceMessageId'> & {
  messageId?: string; contextThroughSequence?: number; context?: { user: string }; progress?: { updatedAt: string };
};
async function inspectSavedRecall(input: Omit<Request, 'type'>, checkpoint: Checkpoint | undefined, request: Transport,
  base: CompanionReplyMemory, sourceChecksum?: string, stillValid?: () => Promise<boolean>): Promise<CompanionReplyMemory> {
  if (!checkpoint?.context || checkpoint.companionId !== input.companionId || checkpoint.conversationId !== input.conversationId
    || checkpoint.messageId !== input.messageId) return base;
  let data: SavedContext;
  try { data = JSON.parse(checkpoint.context.user) as SavedContext; } catch { return base; }
  if (!data?.memoryRecall) return base;
  const scope = { companionId: input.companionId, conversationId: input.conversationId,
    beforeSequence: data.memoryRecall.context?.evidence?.beforeSequence ?? checkpoint.contextThroughSequence ?? undefined };
  const source = (await request({ type: 'memory.sources.filter', ...scope, ids: [checkpoint.sourceMessageId] })).memorySources?.[0];
  const withdrawn = (): CompanionReplyMemory => ({ ...base, state: 'withdrawn',
    explanation: '这条回复引用的来源或记忆已经修改、撤回或不再获权。历史上下文已隐藏，不重新推测当时想起了什么。' });
  if (!source) return withdrawn();
  if (sourceChecksum && createHash('sha256').update(source.content).digest('hex') !== sourceChecksum) return withdrawn();
  if (data.taskRequest?.sourceMessageId === source.id && typeof data.taskRequest.prompt === 'string' && data.taskRequest.prompt !== source.content) return withdrawn();
  const context = data.memoryRecall.context;
  const dependencies = companionMemoryContextDependencies(context);
  if (dependencies.malformed) return withdrawn();
  const frozen = dependencies.complete ? dependencies.frozenMemories : undefined;
  const valid = (notes: readonly CompanionMemory[], revision: string) => !context || (context.evidence
    ? recallCorpusHash(notes.filter(note => Date.parse(note.createdAt) <= Date.parse(context.evidence!.capturedAt))) === context.evidence.corpusHash
    : revision === context.revision);
  const original = [...new Map([...(data.memories ?? []), ...(data.memoryRecall.reasons ?? [])
    .flatMap(item => item.version ? [{ id: item.id, version: item.version }] : [])].map(item => [item.id, item])).values()].slice(0, 12);
  const validateFrozen = async () => {
    for (let offset = 0; offset < Math.max(1, frozen!.length); offset += 100) {
      const checked = await request({ type: 'memory.frozen.valid', ...scope, memories: frozen!.slice(offset, offset + 100) });
      if (!checked.ok || !checked.memoryFrozenValid) return false;
    }
    return true;
  };
  const readCandidates = async () => original.length
    ? (await request({ type: 'memory.records.filter', ...scope, ids: original.map(note => note.id) })).memories : [];
  let currentNotes: CompanionMemory[];
  if (frozen) {
    // A complete task-passive receipt identifies the physical inputs already
    // consumed. Inspecting it must not scan/materialize the owner's whole
    // notebook twice, or reinterpret it through today's unrelated corpus.
    if (!await validateFrozen()) return withdrawn();
    const selected = await readCandidates(); if (!selected) return withdrawn();
    currentNotes = selected;
  } else {
    // Legacy receipts did not record a complete dependency closure. Keep the
    // original conservative corpus check; never invent a precise proof.
    const snapshot = (await request({ type: 'memory.snapshot', ...scope })).memorySnapshot;
    if (!snapshot || !valid(snapshot.notes, snapshot.revision)) return withdrawn();
    currentNotes = snapshot.notes;
  }
  const current = new Map(currentNotes.filter(note => note.companionId === input.companionId).map(note => [note.id, note]));
  const notes = original.flatMap(note => {
    const found = current.get(note.id);
    return found?.version === note.version ? [found] : [];
  });
  if (notes.length !== original.length) return withdrawn();
  const sourceIds = [...new Set(notes.flatMap(note => note.sources.slice(0, 3).map(item => item.messageId)))];
  const sources = sourceIds.length ? (await request({ type: 'memory.sources.filter', ...scope, ids: sourceIds })).memorySources ?? [] : [];
  const sourcesById = new Map<string, CompanionMessage>(sources.map(item => [item.id, item]));
  if (frozen) {
    const checked = await readCandidates();
    if (!checked || recallCorpusHash(checked) !== recallCorpusHash(notes) || !await validateFrozen()) return withdrawn();
  } else {
    const verified = (await request({ type: 'memory.snapshot', ...scope })).memorySnapshot;
    if (!verified || !valid(verified.notes, verified.revision)) return withdrawn();
  }
  const currentSource = (await request({ type: 'memory.sources.filter', ...scope, ids: [checkpoint.sourceMessageId] })).memorySources?.[0];
  if (!currentSource || currentSource.id !== source.id || currentSource.conversationId !== source.conversationId
    || currentSource.content !== source.content) return withdrawn();
  if (stillValid && !await stillValid()) return withdrawn();
  // The exact native text can contain topic-focused synthesis; top-K candidates
  // are evidence candidates, not a fabricated list of what VCP finally injected.
  const text = context?.text ?? '', start = Math.min(input.contextOffset, text.length), end = Math.min(start + input.contextLimit, text.length);
  return { ...base, state: 'ready', observedAt: context?.evidence?.capturedAt ?? checkpoint.progress?.updatedAt ?? base.observedAt,
    query: (data.memoryRecall.continuation?.query?.query ?? source.content).slice(0, 16000),
    contextText: text.slice(start, end), contextCharacters: text.length, contextOffset: start,
    ...(end < text.length ? { nextContextOffset: end } : {}), contextTruncated: start > 0 || end < text.length,
    pending: data.memoryRecall.pending === true, degraded: data.memoryRecall.degraded === true,
    candidates: notes.map(note => ({ id: note.id, version: note.version,
      title: String(note.metadata?.title ?? note.content.split('\n').find(line => line.trim()) ?? note.diaryName ?? '记忆').slice(0, 160),
      content: note.content.slice(0, 2000), contentTruncated: note.content.length > 2000, tags: note.tags.slice(0, 50), createdAt: note.createdAt,
      sourceCount: note.sources.length, sources: note.sources.slice(0, 3).flatMap(ref => {
        const item = sourcesById.get(ref.messageId);
        return item ? [{ messageId: item.id, conversationId: item.conversationId, authorId: item.authorId,
          createdAt: item.createdAt, excerpt: item.content.slice(0, 600) }] : [];
      }) })),
    explanation: text ? '这是本轮保存的 VCP 被动召回原文；候选记忆另列，不代表每条候选都被注入。'
      : data.memoryRecall.degraded ? '本轮被动召回未能正常完成，没有注入 VCP 记忆正文。'
        : '本轮没有注入相关的 VCP 记忆正文；近期会话消息与长期记忆召回是不同来源。',
  };
}
