import { describe, expect, it, vi } from 'vitest';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { probeCompanionMemory } from '../../src/main/companions/memory-probe';
import { companionMemoryProbeCommand, companionMemoryProbeSchema } from '../../src/shared/companion-memory-probe';
import type { CompanionMemoryProbeProgressEvent } from '../../src/shared/companion-memory-probe-progress';
import { projectCompanionMemoryRetrieval } from '../../src/main/companions/memory-retrieval';
import type { CompanionMemorySearch } from '../../src/shared/companion-memory';

describe('human validation uses the actual companion memory tool', () => {
  it.each(['active', 'passive'] as const)('delegates %s exactly to the shared memory search without a management corpus or fallback', async mode => {
    const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'memory.library.scope'
      ? { ok: true, conversation: { id: 'private_alice', kind: 'private', title: 'Alice', memberIds: ['alice'], muted: false, pinned: false, unread: 0, updatedAt: '', lastMessage: '' } }
      : command.type === 'memory.corpus.stamp' ? { ok: true, memoryCorpusStamp: 'corpus_alice_1' }
        : { ok: true, memoryStatus: { pending: 1, running: 0, completed: 0, failed: 0, memories: 0, forgotten: 0, indexed: 0, pendingIndex: 0, messageWatermark: 0, captureWatermark: 0 } });
    const memoryRetrieval = projectCompanionMemoryRetrieval({ mode, observedAt: '', documentCount: 1, hits: [], contextText: '原版 VCP 实际返回原文' });
    const search = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true, memoryPage: { items: [], hasMore: false }, memoryRetrieval, memoryContext: { text: '原版 VCP 实际返回原文', revision: 'revision', profileKey: 'bundled' } }));
    const result = await probeCompanionMemory(companionMemoryProbeCommand.parse({ type: 'memory.recall.test', companionId: 'alice', query: '我叫什么名字？', mode, requestId: `probe-${mode}` }), { request, search });
    expect(search).toHaveBeenCalledExactlyOnceWith({ companionId: 'alice', conversationId: 'private_alice', query: '我叫什么名字？', limit: 8 }, mode, expect.any(Function));
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

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const room: NonNullable<CompanionStorageResponse['conversation']> = {
  id: 'private_alice', kind: 'private', title: 'Alice', memberIds: ['alice'], muted: false, pinned: false, unread: 0, updatedAt: '', lastMessage: '',
};

it('records backend preparation before native progress, every actual phase and a terminal frozen receipt', async () => {
  let now = 100, notify: ((stage: string) => void) | undefined;
  const scope = deferred<CompanionStorageResponse>(), searching = deferred<void>(), result = deferred<CompanionStorageResponse>();
  const progress: CompanionMemoryProbeProgressEvent[] = [];
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'memory.library.scope' ? scope.promise
    : command.type === 'memory.corpus.stamp' ? { ok: true, memoryCorpusStamp: 'stable-corpus' } : { ok: true });
  const search = vi.fn(async (...args: [CompanionMemorySearch, 'active' | 'passive', ((stage: string) => void)?]) => { notify = args[2]; searching.resolve(); return result.promise; });
  const pending = probeCompanionMemory({ type: 'memory.recall.test', companionId: 'alice', mode: 'passive', query: '明确话题', requestId: 'backend-live-test' },
    { request, search, now: () => now, onProgress: event => progress.push(event) });
  expect(progress[0]).toMatchObject({ requestId: 'backend-live-test', companionId: 'alice', mode: 'passive', state: 'running', stageId: 'preparation', elapsedMs: 0 });
  now = 600; scope.resolve({ ok: true, conversation: room }); await searching.promise;
  notify!('等待本伙伴的记忆查询');
  now = 850; notify!('核验记忆来源');
  now = 1000; notify!('连接记忆引擎');
  now = 1100; notify!('同步本轮记忆索引');
  now = 1300; notify!('准备原版 VCP 话题检索');
  now = 1600; notify!('VCP 正在按当前话题聚焦回忆');
  now = 2600; notify!('核验本轮回忆');
  now = 2700; result.resolve({ ok: true, memoryPage: { items: [], hasMore: false }, memoryContext: { text: '真实管线原文', revision: 'stable', profileKey: 'fixture' } });
  const recalled = await pending;
  expect(recalled.timing).toMatchObject({ totalMs: 2600 });
  expect(recalled.timing?.stages.map(stage => [stage.id, stage.elapsedMs])).toEqual([
    ['preparation', 500], ['queue', 250], ['sources', 150], ['runtime', 100], ['projection', 200], ['retrieval', 300], ['focus', 1000], ['verification', 100],
  ]);
  expect(progress.at(-1)).toMatchObject({ state: 'completed', elapsedMs: 2600, stageId: 'verification', stageElapsedMs: 100 });
  expect(progress.every((event, index) => index === 0 || event.sequence! > progress[index - 1]!.sequence!)).toBe(true);
  const frozen = structuredClone(progress), timing = structuredClone(recalled.timing);
  now = 999_999; notify!('检索相关记忆');
  expect(progress).toEqual(frozen); expect(recalled.timing).toEqual(timing);
});

it('emits failure timing and ignores late native updates without replacing the original failure', async () => {
  let now = 0, notify: ((stage: string) => void) | undefined;
  const searching = deferred<void>(), result = deferred<CompanionStorageResponse>(), progress: CompanionMemoryProbeProgressEvent[] = [];
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'memory.library.scope'
    ? { ok: true, conversation: room } : { ok: true, memoryCorpusStamp: 'stable-corpus' });
  const search = vi.fn(async (...args: [CompanionMemorySearch, 'active' | 'passive', ((stage: string) => void)?]) => { notify = args[2]; searching.resolve(); return result.promise; });
  const pending = probeCompanionMemory({ type: 'memory.recall.test', companionId: 'alice', mode: 'active', query: '明确话题', requestId: 'backend-failure-test' },
    { request, search, now: () => now, onProgress: event => progress.push(event) });
  const rejected = expect(pending).rejects.toThrow('原版查询真实失败');
  await searching.promise; notify!('等待本伙伴的记忆查询');
  now = 50; notify!('整理检索片段'); now = 1250; result.reject(new Error('原版查询真实失败')); await rejected;
  expect(progress.at(-1)).toMatchObject({ state: 'failed', elapsedMs: 1250, stageId: 'focus', stageElapsedMs: 1200 });
  const frozen = structuredClone(progress); now = 99_999; notify!('核验本轮回忆'); expect(progress).toEqual(frozen);
});
