import type { z } from 'zod';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemorySearch } from '../../shared/companion-memory';
import type { companionMemoryProbeCommand, CompanionMemoryProbe } from '../../shared/companion-memory-probe';

/** The diagnostic has no alternative search index, scoring or model provider. */
export async function probeCompanionMemory(input: z.infer<typeof companionMemoryProbeCommand>, options: {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  search(query: CompanionMemorySearch, mode: 'active' | 'passive'): Promise<CompanionStorageResponse>;
}): Promise<CompanionMemoryProbe> {
  const scope = (await options.request({ type: 'memory.library.scope', companionId: input.companionId })).conversation;
  if (!scope?.memberIds.includes(input.companionId)) throw new Error('这位伙伴的记忆范围暂不可用。');
  const before = (await options.request({ type: 'memory.corpus.stamp', companionId: input.companionId })).memoryCorpusStamp;
  const result = await options.search({ companionId: input.companionId, conversationId: scope.id,
    query: input.query, limit: input.limit ?? 8 }, input.mode);
  if (!result.ok) throw new Error(result.error ?? 'VCP 记忆工具暂不可用。');
  const status = (await options.request({ type: 'memory.status', companionId: input.companionId })).memoryStatus;
  const memories = (result.memoryPage?.items ?? []).slice(0, input.limit ?? 8);
  if (memories.some(hit => hit.memory.companionId !== input.companionId)) throw new Error('召回结果的伙伴归属未通过核验。');
  const text = result.memoryContext?.text ?? '';
  const after = (await options.request({ type: 'memory.corpus.stamp', companionId: input.companionId })).memoryCorpusStamp;
  if (!before || after !== before) throw new Error('记忆在检索期间发生了变化，请重新验证。');
  return { companionId: input.companionId, mode: input.mode, query: input.query, observedAt: new Date().toISOString(),
    corpusStamp: after,
    ...(result.memoryRetrieval ? { memoryRetrieval: result.memoryRetrieval } : {}),
    contextText: text, memories, pending: !!status && status.pending + status.running + status.pendingIndex > 0,
    degraded: memories.some(hit => hit.reasons.includes('原生召回已降级')),
    explanation: input.mode === 'active'
      ? '使用伙伴 memory.search 的同一入口：内置向量模型、原版 VCP RiverMemo 与 LightMemo。原文为工具实际返回内容；候选单独列出。'
      : '使用伙伴回答前被动召回的同一入口：原版 VCP 话题聚焦与 RiverMemo。此处仅将你的查询作为话题，不附加某个聊天的近期消息。候选不等于实际注入内容。',
  };
}
