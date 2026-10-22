import { describe, expect, it, vi } from 'vitest';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { probeCompanionMemory } from '../../src/main/companions/memory-probe';
import { companionMemoryProbeCommand, companionMemoryProbeSchema } from '../../src/shared/companion-memory-probe';
import { projectCompanionMemoryRetrieval } from '../../src/main/companions/memory-retrieval';

describe('human validation uses the actual companion memory tool', () => {
  it.each(['active', 'passive'] as const)('delegates %s exactly to the shared memory search without a management corpus or fallback', async mode => {
    const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'memory.library.scope'
      ? { ok: true, conversation: { id: 'private_alice', kind: 'private', title: 'Alice', memberIds: ['alice'], muted: false, pinned: false, unread: 0, updatedAt: '', lastMessage: '' } }
      : command.type === 'memory.corpus.stamp' ? { ok: true, memoryCorpusStamp: 'corpus_alice_1' }
        : { ok: true, memoryStatus: { pending: 1, running: 0, completed: 0, failed: 0, memories: 0, forgotten: 0, indexed: 0, pendingIndex: 0, messageWatermark: 0, captureWatermark: 0, backfillTarget: 0, backfillThrough: 0 } });
    const memoryRetrieval = projectCompanionMemoryRetrieval({ mode, observedAt: '', documentCount: 1, hits: [], contextText: '原版 VCP 实际返回原文' });
    const search = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true, memoryPage: { items: [], hasMore: false }, memoryRetrieval, memoryContext: { text: '原版 VCP 实际返回原文', revision: 'revision', profileKey: 'bundled' } }));
    const result = await probeCompanionMemory(companionMemoryProbeCommand.parse({ type: 'memory.recall.test', companionId: 'alice', query: '我叫什么名字？', mode }), { request, search });
    expect(search).toHaveBeenCalledExactlyOnceWith({ companionId: 'alice', conversationId: 'private_alice', query: '我叫什么名字？', limit: 8 }, mode);
    expect(result).toMatchObject({ companionId: 'alice', mode, contextText: '原版 VCP 实际返回原文', pending: true, degraded: false });
    expect(result.memoryRetrieval).toEqual(memoryRetrieval);
    expect(companionMemoryProbeSchema.safeParse(result).success).toBe(true);
    expect(request.mock.calls.map(([command]) => command.type)).toEqual(['memory.library.scope', 'memory.corpus.stamp', 'memory.status', 'memory.corpus.stamp']);
  });

  it('surfaces a failed native query without replacing it with keyword or management search', async () => {
    const request = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true, conversation: { id: 'private_alice', kind: 'private', title: '', memberIds: ['alice'], muted: false, pinned: false, unread: 0, updatedAt: '', lastMessage: '' } }));
    const search = vi.fn(async () => { throw new Error('原版 VCP 话题聚焦不可用'); });
    await expect(probeCompanionMemory({ type: 'memory.recall.test', companionId: 'alice', query: '名字', mode: 'passive' }, { request, search })).rejects.toThrow('原版 VCP 话题聚焦不可用');
    expect(search).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(2);
  });
});
