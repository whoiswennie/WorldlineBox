import type { z } from 'zod';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemorySearch } from '../../shared/companion-memory';
import type { companionMemoryProbeCommand, CompanionMemoryProbe } from '../../shared/companion-memory-probe';
import type { CompanionMemoryProbeProgressEvent } from '../../shared/companion-memory-probe-progress';
import { CompanionMemoryProbeProgressRecorder } from './memory-probe-progress';

/** The diagnostic shares the companion's search entry, including its native
 * preprocessing and generation route. It never uses the human management index.
 * It supplies a standalone topic; chat recall additionally supplies dialogue. */
export async function probeCompanionMemory(input: z.infer<typeof companionMemoryProbeCommand>, options: {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  search(query: CompanionMemorySearch, mode: 'active' | 'passive', onProgress?: (stage: string) => void): Promise<CompanionStorageResponse>;
  onProgress?(event: CompanionMemoryProbeProgressEvent): void;
  onProgressError?(error: unknown): void;
  now?: () => number;
}): Promise<CompanionMemoryProbe> {
  const progress = new CompanionMemoryProbeProgressRecorder({ requestId: input.requestId, companionId: input.companionId, mode: input.mode,
    onProgress: options.onProgress, onProgressError: options.onProgressError, now: options.now });
  try {
    const scope = (await options.request({ type: 'memory.library.scope.read', companionId: input.companionId })).conversation;
    if (!scope?.memberIds.includes(input.companionId)) throw new Error('这位伙伴的记忆范围暂不可用。');
    const before = (await options.request({ type: 'memory.lifecycle.state', companionId: input.companionId })).memoryLifecycleState;
    if (!before || before.companionId !== input.companionId) throw new Error('本次回忆的来源撤销凭证暂不可用。');
    const authority = (await options.request({ type: 'memory.recall.authority', companionId: input.companionId })).memoryRecallAuthorityStamp;
    if (!authority) throw new Error('本次回忆的来源授权版本暂不可用。');
    const result = await options.search({ companionId: input.companionId, conversationId: scope.id,
      query: input.query, limit: input.limit ?? 8 }, input.mode, stage => progress.progress(stage));
    progress.stage('verification');
    if (!result.ok) throw new Error(result.error ?? 'VCP 记忆工具暂不可用。');
    const status = (await options.request({ type: 'memory.status', companionId: input.companionId })).memoryStatus;
    const memories = (result.memoryPage?.items ?? []).slice(0, input.limit ?? 8);
    if (memories.some(hit => hit.memory.companionId !== input.companionId)) throw new Error('召回结果的伙伴归属未通过核验。');
    const text = result.memoryContext?.text ?? '';
    const after = (await options.request({ type: 'memory.corpus.stamp', companionId: input.companionId })).memoryCorpusStamp;
    const current = (await options.request({ type: 'memory.lifecycle.state', companionId: input.companionId })).memoryLifecycleState;
    const authorityAfter = (await options.request({ type: 'memory.recall.authority', companionId: input.companionId })).memoryRecallAuthorityStamp;
    // Search validates its captured canonical inputs and indexed read view.
    // Background additions/publications do not revoke that snapshot. A hard
    // withdrawal still invalidates the result immediately before publication.
    if (!after || !current || current.companionId !== input.companionId || current.revocationEpoch !== before.revocationEpoch || authorityAfter !== authority)
      throw new Error('回忆的来源或授权在检索期间已撤回，请重新验证。');
    return { companionId: input.companionId, mode: input.mode, query: input.query, observedAt: new Date().toISOString(),
      corpusStamp: after, authorityStamp: authority, timing: progress.complete(),
      ...(result.memoryRetrieval ? { memoryRetrieval: result.memoryRetrieval } : {}),
      contextText: text, memories, pending: !!status && status.pending + status.running + status.pendingIndex > 0,
      degraded: memories.some(hit => hit.reasons.includes('原生召回已降级')),
      explanation: input.mode === 'active'
        ? '使用伙伴 memory.search 的同一入口：内置向量模型、原版 VCP RiverMemo 与 LightMemo。原文为工具实际返回内容；候选单独列出。'
        : '使用伙伴回答前被动召回的同一入口：在完整获权记忆图上执行原版 VCP RiverMemo，返回实际相关片段，默认不额外调用聚焦模型。显示条数只限制诊断列表。此处仅将你的查询作为话题，不附加某个聊天的近期消息；实际聊天会加入获权近期语境。列表不等于实际注入内容。',
    };
  } catch (error) { progress.fail(); throw error; }
}
