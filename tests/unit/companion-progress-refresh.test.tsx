// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Companions } from '../../src/renderer/companions/Companions';
import { CompanionRecentReadCache } from '../../src/renderer/companions/recent-read-cache';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { CompanionChangeEvent, CompanionMessage, CompanionReplyStreamEvent, CompanionRuntimeProgress, CompanionState, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { applyCompanionRuntimeProgress } from '../../src/renderer/companions/runtime-progress';
import { companionChangeEventSchema } from '../../src/shared/companions';

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

it('ignores continuous memory status/content notifications without clearing chat caches or reading state, history, actions or topics', async () => {
  const f = await mount(), clear = vi.spyOn(CompanionRecentReadCache.prototype, 'clear');
  await act(async () => {
    for (let index = 0; index < 30; index++) {
      f.changed({ kind: 'memory', change: index % 2 ? 'status' : 'content', companionIds: index % 3 ? [BUILTIN_COMPANIONS[0]!.id] : [] });
      await vi.advanceTimersByTimeAsync(100);
    }
  });
  expect(f.request.mock.calls.filter(([command]) => ['state', 'state.progress', 'messages', 'actions', 'topic.list', 'topic.read'].includes(command.type))).toEqual([]);
  expect(clear).not.toHaveBeenCalled();
  expect(host!.querySelector('[data-companion-messages]')!.textContent).toContain(f.source.content);
});

it('keeps immediate full invalidation and a fresh withdrawal read when memory events surround the hard notification', async () => {
  const f = await mount(); f.messages([f.source, f.reply]);
  await act(async () => { f.changed(); await vi.advanceTimersByTimeAsync(1000); });
  const clear = vi.spyOn(CompanionRecentReadCache.prototype, 'clear'); f.request.mockClear();
  f.messages([f.source, { ...f.reply, content: '', segments: undefined, sourceUnavailable: 'execution_source_changed' }]);
  await act(async () => {
    f.changed({ kind: 'memory', change: 'content', companionIds: [] }); f.changed();
    expect(clear).toHaveBeenCalled();
    for (let index = 0; index < 30; index++) f.changed({ kind: 'memory', change: 'status', companionIds: [] });
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(f.request.mock.calls.some(([command]) => command.type === 'state')).toBe(true);
  expect(contentReads(f.request).map(([command]) => command.type)).toEqual(expect.arrayContaining(['messages', 'actions', 'topic.list']));
  expect(host!.querySelector('[data-companion-messages]')!.textContent).not.toContain(f.reply.content);
  expect(host!.textContent).toContain('此消息引用的资料已变化');
});

it('does not suppress a real transcript insertion or unknown/malformed legacy event after memory-only notifications', async () => {
  const f = await mount(); f.messages([f.source, f.reply]);
  await act(async () => {
    f.changed({ kind: 'memory', change: 'content', companionIds: [] }); f.changed(); await vi.advanceTimersByTimeAsync(1000);
  });
  expect(host!.querySelector('[data-companion-messages]')!.textContent).toContain(f.reply.content);
  f.request.mockClear();
  for (const unknown of [{ kind: 'unrecognized' }, { kind: 'memory', change: 'status', companionIds: ['bad/id'] }, { kind: 'memory' }]) {
    const parsed = companionChangeEventSchema.safeParse(unknown); expect(parsed.success).toBe(false);
    // This is the preload bridge's real fallback: invalid inputs are full.
    await act(async () => { f.changed(parsed.success ? parsed.data : undefined); await vi.advanceTimersByTimeAsync(600); });
  }
  expect(f.request.mock.calls.filter(([command]) => command.type === 'messages')).toHaveLength(3);
});

it('rejects an older in-flight page as soon as a hard event arrives, before the next coalesced read starts', async () => {
  const f = await mount(), original = f.request.getMockImplementation()!;
  let finish!: (value: CompanionsResponse) => void, held = false;
  f.request.mockImplementation(input => {
    if (input.type === 'messages' && !held) { held = true; return new Promise(resolve => { finish = resolve; }); }
    return original(input);
  });
  await act(async () => { f.changed(); await vi.advanceTimersByTimeAsync(600); });
  expect(held).toBe(true);
  f.messages([f.source, { ...f.reply, content: '', segments: undefined, sourceUnavailable: 'execution_source_changed' }]);
  await act(async () => {
    f.changed(); f.changed({ kind: 'memory', change: 'content', companionIds: [] });
    finish({ ok: true, messages: [f.source, f.reply], hasMore: false });
    await Promise.resolve();
  });
  expect(host!.querySelector('[data-companion-messages]')!.textContent).not.toContain(f.reply.content);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(host!.querySelector('[data-companion-messages]')!.textContent).not.toContain(f.reply.content);
  expect(host!.textContent).toContain('此消息引用的资料已变化');
});

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

it('reads history once for a sent message, keeps enqueue/index progress light and still retracts a withdrawn body', async () => {
  const f = await mount(), original = f.request.getMockImplementation()!;
  const accepted = { ...f.source, id: 'next-user', sequence: 3, content: '新任务已经送达。' };
  f.messages([f.source, f.reply]);
  await act(async () => { f.changed(); await vi.advanceTimersByTimeAsync(1000); });
  f.request.mockClear();
  f.request.mockImplementation(async input => {
    if (input.type !== 'message.send') return original(input);
    // The real service emits a full insertion event before returning its ACK.
    f.messages([f.source, f.reply, accepted]); f.changed();
    return { ok: true, message: accepted, inserted: true };
  });
  const input = host!.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, accepted.content);
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => host!.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(host!.querySelector('[data-companion-messages]')!.textContent).toContain(accepted.content);
  expect(f.request.mock.calls.filter(([command]) => command.type === 'messages')).toHaveLength(1);

  // Enqueue and native-index completion may arrive after the first batch.
  await act(async () => { f.progress(1); f.changed({ kind: 'progress' }); await vi.advanceTimersByTimeAsync(600);
    f.changed({ kind: 'progress' }); await vi.advanceTimersByTimeAsync(600); });
  expect(f.request.mock.calls.filter(([command]) => command.type === 'messages')).toHaveLength(1);
  expect(f.request.mock.calls.some(([command]) => command.type === 'state.progress')).toBe(true);
  f.messages([f.source, { ...f.reply, content: '', segments: undefined, sourceUnavailable: 'execution_source_changed' }, accepted]);
  await act(async () => { f.changed(); f.changed({ kind: 'progress' }); await vi.advanceTimersByTimeAsync(1000); });
  expect(f.request.mock.calls.filter(([command]) => command.type === 'messages')).toHaveLength(2);
  expect(host!.querySelector('[data-companion-messages]')!.textContent).not.toContain(f.reply.content);
  expect(host!.textContent).toContain('此消息引用的资料已变化');
});
