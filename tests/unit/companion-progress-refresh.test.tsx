// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Companions } from '../../src/renderer/companions/Companions';
import { CompanionRecentReadCache } from '../../src/renderer/companions/recent-read-cache';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { CompanionChangeEvent, CompanionMessage, CompanionReplyStreamEvent, CompanionRuntimeProgress, CompanionState, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { applyCompanionRuntimeProgress } from '../../src/renderer/companions/runtime-progress';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });

async function mount() {
  vi.useFakeTimers();
  const at = new Date().toISOString(), companion = { ...BUILTIN_COMPANIONS[0]!, builtin: true, createdAt: at };
  const room = { id: 'progress-private', kind: 'private' as const, title: companion.name, memberIds: [companion.id], pinned: false, muted: false, unread: 0, updatedAt: at, lastMessage: '现在忙吗' };
  const state: CompanionState = { companions: [companion], conversations: [room], activities: [], configured: true };
  const source: CompanionMessage = { id: 'source', conversationId: room.id, authorId: 'user', sequence: 1, kind: 'text', status: 'sent', content: '现在忙吗', createdAt: at, attachments: [] };
  const reply: CompanionMessage = { ...source, id: 'reply', authorId: companion.id, sequence: 2, replyToId: source.id,
    content: '这条回复已经实际完成。', segments: [{ text: '这条回复已经实际完成。', actionIds: [] }] };
  let messages = [source], changed: ((change?: CompanionChangeEvent) => void) | undefined, stream: ((event: CompanionReplyStreamEvent) => void) | undefined;
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'state' ? { ok: true, state }
    : input.type === 'state.progress' ? { ok: true, runtimeProgress: { queue: [], activities: [], owners: [] } }
    : input.type === 'messages' ? { ok: true, messages: [...messages], hasMore: false, hasNewer: false }
      : input.type === 'actions' ? { ok: true, actions: [] } : input.type === 'topic.list' ? { ok: true, topics: [] } : { ok: true });
  const api: WorldlineBoxCompanionsApi = { request,
    onChanged(listener) { changed = listener; return () => { changed = undefined; }; },
    onReplyStream(listener) { stream = listener; return () => { stream = undefined; }; },
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<Companions api={api} onOpenSettings={() => undefined} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  request.mockClear();
  return { request, source, reply, changed: (change?: CompanionChangeEvent) => changed?.(change),
    messages: (next: CompanionMessage[]) => { messages = next; },
    progress: (revision: number) => stream?.({ conversationId: room.id, companionId: companion.id, sourceMessageId: source.id,
      messageId: reply.id, phase: 'progress', step: 0, attemptId: 'attempt', text: '', messageIdentity: { sequence: reply.sequence, createdAt: at },
      progress: { workId: 'work', sourceMessageId: source.id, revision, phase: 'memory', detail: `正在回忆 ${revision}`, startedAt: at, updatedAt: at, timing: { elapsedMs: 0, activeSince: at } } }),
  };
}

const contentReads = (request: { mock: { calls: [CompanionsRequest][] } }) => request.mock.calls.filter(([input]) => ['messages', 'actions', 'topic.list', 'topic.read'].includes(input.type));

it('applies streamed progress immediately while its notification refreshes only state and retains chat caches', async () => {
  const f = await mount(), clear = vi.spyOn(CompanionRecentReadCache.prototype, 'clear');
  await act(async () => { f.progress(1); for (let i = 0; i < 30; i++) f.changed({ kind: 'progress' }); });
  expect(host!.querySelector('[data-companion-messages] [data-reply-stage="memory"]')).not.toBeNull();
  expect(host!.querySelector('[data-companion-messages]')!.textContent).toContain('正在查找相关回忆');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(f.request.mock.calls.some(([input]) => input.type === 'state.progress')).toBe(true);
  expect(f.request.mock.calls.some(([input]) => input.type === 'state')).toBe(false);
  expect(contentReads(f.request)).toHaveLength(0); expect(clear).not.toHaveBeenCalled();

  f.messages([f.source, f.reply]);
  await act(async () => f.changed());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(contentReads(f.request).map(([input]) => input.type)).toEqual(expect.arrayContaining(['messages', 'actions', 'topic.list']));
  expect(clear).toHaveBeenCalled(); expect(host!.querySelector('[data-companion-messages]')!.textContent).toContain(f.reply.content);

  f.messages([f.source, { ...f.reply, content: '', segments: undefined, sourceUnavailable: 'execution_source_changed' }]);
  await act(async () => f.changed());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(host!.querySelector('[data-companion-messages]')!.textContent).not.toContain(f.reply.content);
  expect(host!.querySelector('[data-companion-messages]')!.textContent).toContain('此消息引用的资料已变化');
});

it('merges runtime status without replacing canonical identity, pictures, configuration or offline authority', () => {
  const at = '2026-10-30T00:00:00Z', canonical = { ...BUILTIN_COMPANIONS[0]!, builtin: true, createdAt: at,
    assetImages: { avatar: { url: 'worldlinebox-companion://portrait/current', sha256: 'a'.repeat(64) } },
    llm: { apiFormat: 'openai_chat' as const, baseUrl: 'https://canonical.invalid', model: 'current', hasKey: true },
    availability: 'working' as const, activeCount: 1, queuedCount: 2 };
  const offline = { ...canonical, id: 'offline', availability: 'offline' as const, availabilityReason: '连接不可用' };
  const state: CompanionState = { companions: [canonical, offline], conversations: [], configured: true, activities: [] };
  const progress: CompanionRuntimeProgress = { queue: [], activities: [], owners: [{ companionId: canonical.id,
    activeCount: 2, queuedCount: 1, activityCount: 1, waitingCount: 1, availability: 'waiting', availabilityReason: '等待工具' }] };
  const next = applyCompanionRuntimeProgress(state, progress);
  expect(next.companions[0]).toMatchObject({ name: canonical.name, persona: canonical.persona, activeCount: 2, queuedCount: 1, availability: 'waiting', availabilityReason: '等待工具' });
  expect(next.companions[0]!.assetImages).toBe(canonical.assetImages); expect(next.companions[0]!.llm).toBe(canonical.llm);
  expect(next.companions[1]).toMatchObject({ availability: 'offline', availabilityReason: '连接不可用', activeCount: 0, queuedCount: 0 });
  const idle = applyCompanionRuntimeProgress(next, { queue: [], activities: [], owners: [] });
  expect(idle.companions[0]).toMatchObject({ availability: 'ready', activeCount: 0, queuedCount: 0 });
  expect(idle.companions[0]!.availabilityReason).toBeUndefined(); expect(idle.conversations).toBe(state.conversations);
});

it('never downgrades a pending full change when progress arrives in the same coalescing window', async () => {
  const f = await mount(); f.messages([f.source, f.reply]);
  await act(async () => { f.changed({ kind: 'progress' }); f.changed(); for (let i = 0; i < 30; i++) f.changed({ kind: 'progress' }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(contentReads(f.request).map(([input]) => input.type)).toEqual(expect.arrayContaining(['messages', 'actions', 'topic.list']));
  expect(host!.querySelector('[data-companion-messages]')!.textContent).toContain(f.reply.content);
});
