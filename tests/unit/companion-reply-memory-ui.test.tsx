// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionMessage, CompanionReplyStreamEvent, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionReplyMemory } from '../../src/shared/companion-reply-memory';
import { CompanionReplyProgress } from '../../src/renderer/companions/CompanionReplyProgress';
import { CompanionReplyMemoryDetails, type ReplyMemoryScope } from '../../src/renderer/companions/CompanionReplyMemoryDetails';
import { CompanionMessageBubble } from '../../src/renderer/companions/CompanionMessageBubble';
import { CompanionReplyStreamStore } from '../../src/renderer/companions/reply-stream';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; Reflect.deleteProperty(window, 'worldlinebox'); vi.useRealTimers(); vi.restoreAllMocks(); });
const at = '2026-10-22T06:15:00.000Z';
const scope: ReplyMemoryScope = { companionId: 'fish', conversationId: 'private-fish', messageId: 'reply-fish' };
function receipt(patch: Partial<CompanionReplyMemory> = {}): CompanionReplyMemory {
  return { ...scope, state: 'ready', observedAt: at, query: '你记得我是谁吗', contextText: '回忆原文：用户在十分钟前自我介绍，名字是天幻呀。', contextOffset: 0,
    contextCharacters: 27, contextTruncated: false, pending: false, degraded: false, explanation: '这份回忆来自本条回复执行时的实际上下文。', candidates: [
      { id: 'note-name', version: 2, title: '第一次认识', content: '用户向我介绍自己的名字。', contentTruncated: false, tags: ['名字', '初次见面'], createdAt: at, sourceCount: 1,
        sources: [{ messageId: 'intro', conversationId: 'private-fish', authorId: 'user', createdAt: at, excerpt: '你好啊，我叫：这就是天幻呀。' }] },
    ], ...patch };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function apiFor(request: WorldlineBoxCompanionsApi['request']) {
  let stamp = 'owner-corpus-1'; const stateRequest = vi.fn(async () => ({ ok: true, memoryCorpusStamp: stamp }));
  const listeners = new Set<() => void>();
  const api: WorldlineBoxCompanionsApi = { request: command => command.type === 'memory.recall.state' ? stateRequest() : request(command), onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, onReplyStream: () => () => undefined };
  return { api, emit: () => { for (const listener of listeners) listener(); }, listeners, stateRequest, setStamp: (value: string) => { stamp = value; } };
}
async function mount(content: React.ReactNode) { node = document.createElement('div'); document.body.append(node); root = createRoot(node); await act(async () => root!.render(content)); }
function button(label: string) {
  const found = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(value => value.getAttribute('aria-label') === label || value.textContent?.trim() === label);
  if (!found) throw new Error('Missing button ' + label); return found;
}

it('does not read any bodies until the user opens one reply and drops the receipt on close', async () => {
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async () => ({ ok: true, replyMemory: receipt() })); const { api, listeners } = apiFor(request);
  Object.defineProperty(window, 'worldlinebox', { configurable: true, value: { companions: api } });
  await mount(<CompanionReplyProgress revealCompleted scope={scope} now={Date.parse(at)} progress={{ revision: 1, phase: 'completed', detail: '回复已完成', startedAt: at, updatedAt: at, memory: { status: 'completed', count: 1, injected: true } }} />);
  expect(request).not.toHaveBeenCalled(); expect(listeners.size).toBe(0); expect(node!.querySelector('[data-reply-memory-context]')).toBeNull();
  await act(async () => button('展开回复过程').click());
  await act(async () => button('查看这次回复的回忆').click());
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'reply.memory.inspect', ...scope, contextOffset: 0, contextLimit: 8192 }); expect(listeners.size).toBe(1);
  expect(node!.querySelector('[data-reply-memory-context]')?.textContent).toBe(receipt().contextText);
  await act(async () => button('关闭回忆详情').click());
  expect(node!.querySelector('[aria-label="本轮回忆详情"]')).toBeNull(); expect(listeners.size).toBe(0);
  await act(async () => button('查看这次回复的回忆').click()); expect(request).toHaveBeenCalledTimes(2);
});

it('keeps a long local preparation stage compact and distinguishes its own time from total reply time', async () => {
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(); const { api } = apiFor(request);
  Object.defineProperty(window, 'worldlinebox', { configurable: true, value: { companions: api } });
  const cancel = vi.fn();
  await mount(<CompanionReplyProgress scope={scope} now={Date.parse(at) + 65_000} onCancel={cancel} progress={{ revision: 2, phase: 'context',
    detail: '被动记忆召回已完成，正在准备对话上下文', startedAt: at, phaseStartedAt: new Date(Date.parse(at) + 60_000).toISOString(), updatedAt: at,
    timing: { elapsedMs: 65_000 }, memory: { status: 'completed', count: 3, injected: false } }} />);
  expect(node!.textContent).toContain('正在整理这次聊天需要的信息'); expect(node!.textContent).toContain('总用时 1 分 05 秒');
  expect(node!.textContent).not.toContain('正在思考'); expect(node!.textContent).not.toContain('上下文'); expect(node!.textContent).not.toContain('候选');
  expect(node!.querySelector('[role="dialog"]')).toBeNull(); expect(request).not.toHaveBeenCalled();
  expect(node!.querySelector('time')!.title).toContain('当前阶段 5 秒');
  await act(async () => button('取消这条回复').click()); expect(cancel).toHaveBeenCalledOnce();
});

it('stops waiting for a hung inspection, permits a new read and ignores the old late body', async () => {
  vi.useFakeTimers(); const first = deferred<CompanionsResponse>();
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>().mockImplementationOnce(() => first.promise).mockResolvedValue({ ok: true, replyMemory: receipt({ contextText: '重新读取的真实记忆' }) });
  const { api } = apiFor(request); await mount(<CompanionReplyMemoryDetails scope={scope} api={api} />);
  expect(button('重新核验本轮回忆').disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(10_001));
  expect(node!.querySelector('[role="alert"]')?.textContent).toContain('可以重新查看或关闭详情');
  expect(button('重新核验本轮回忆').disabled).toBe(false);
  await act(async () => button('重新核验本轮回忆').click());
  expect(node!.querySelector('[data-reply-memory-context]')?.textContent).toBe('重新读取的真实记忆');
  await act(async () => first.resolve({ ok: true, replyMemory: receipt({ contextText: '已经过期的迟到正文' }) }));
  expect(node!.textContent).not.toContain('已经过期的迟到正文');
  expect(request.mock.calls.every(([command]) => command.type === 'reply.memory.inspect')).toBe(true);
});

it('keeps exact injected text distinct from candidates and renders original source evidence literally', async () => {
  const exact = '  实际上下文\n\n<script>不能执行</script>\n名字：天幻呀。\n';
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async () => ({ ok: true, replyMemory: receipt({ contextText: exact, contextCharacters: exact.length }) })); const { api } = apiFor(request);
  await mount(<CompanionReplyMemoryDetails scope={scope} api={api} />);
  expect(node!.querySelector('[data-reply-memory-context]')?.textContent).toBe(exact); expect(node!.querySelector('script')).toBeNull();
  expect(node!.textContent).toContain('实际进入本轮上下文的内容以上方原文为准');
  expect(node!.querySelector('[data-recall-candidate="note-name"]')?.textContent).toContain('版本 2');
  expect(node!.querySelector('blockquote')?.textContent).toContain('你好啊，我叫：这就是天幻呀。');
  expect(node!.textContent).toContain('这次在回想什么'); expect(node!.textContent).toContain('名字');
  expect(node!.textContent).not.toContain('已学会');
});

it('replaces bounded server pages rather than accumulating recalled context in the DOM', async () => {
  const first = '文'.repeat(8192), second = '末尾原文😀';
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async command => {
    if (command.type !== 'reply.memory.inspect') return { ok: false };
    return { ok: true, replyMemory: receipt({ contextOffset: command.contextOffset, contextText: command.contextOffset ? second : first,
      contextCharacters: first.length + second.length, contextTruncated: true, nextContextOffset: command.contextOffset ? undefined : first.length }) };
  }); const { api } = apiFor(request);
  await mount(<CompanionReplyMemoryDetails scope={scope} api={api} />);
  expect(node!.querySelector('[data-reply-memory-context]')!.textContent).toBe(first);
  await act(async () => button('下一段').click()); expect(request.mock.lastCall?.[0]).toMatchObject({ ...scope, contextOffset: first.length });
  expect(node!.querySelector('[data-reply-memory-context]')!.textContent).toBe(second); expect(node!.textContent).not.toContain('文'.repeat(100));
  expect(node!.textContent).toContain('第 2 段'); expect(button('下一段').disabled).toBe(true);
  await act(async () => button('上一段').click()); expect(request.mock.lastCall?.[0]).toMatchObject({ contextOffset: 0 });
  expect(node!.querySelectorAll('[data-reply-memory-context]')).toHaveLength(1); expect(node!.querySelector('[data-reply-memory-context]')!.textContent).toBe(first);
});

it('rechecks genuine corpus changes and never renders a withdrawn payload body', async () => {
  vi.useFakeTimers(); const reread = deferred<CompanionsResponse>();
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>().mockResolvedValueOnce({ ok: true, replyMemory: receipt() }).mockImplementation(() => reread.promise);
  const { api, emit, setStamp } = apiFor(request); await mount(<CompanionReplyMemoryDetails scope={scope} api={api} />);
  expect(node!.textContent).toContain('名字是天幻呀');
  setStamp('owner-corpus-2'); await act(() => emit()); await act(async () => vi.advanceTimersByTimeAsync(751));
  expect(node!.textContent).not.toContain('名字是天幻呀'); expect(node!.querySelector('[data-recall-candidate]')).toBeNull();
  await act(async () => reread.resolve({ ok: true, replyMemory: receipt({ state: 'withdrawn', explanation: '相关来源已撤回，旧正文不可再展示。', contextText: '不得复活的私人正文' }) }));
  expect(node!.textContent).toContain('相关来源已撤回'); expect(node!.textContent).not.toContain('不得复活'); expect(node!.querySelector('[data-reply-memory-context], [data-recall-candidate]')).toBeNull();
});

it('preserves the open receipt through unrelated world events and checks only a lightweight corpus stamp', async () => {
  vi.useFakeTimers(); const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async () => ({ ok: true, replyMemory: receipt() }));
  const { api, emit, stateRequest } = apiFor(request); await mount(<CompanionReplyMemoryDetails scope={scope} api={api} />);
  const original = node!.querySelector('[data-reply-memory-context]');
  await act(() => { emit(); emit(); emit(); }); await act(async () => vi.advanceTimersByTimeAsync(751));
  expect(node!.querySelector('[data-reply-memory-context]')).toBe(original); expect(request).toHaveBeenCalledTimes(1); expect(stateRequest).toHaveBeenCalledTimes(2);
});

it('rejects wrong-owner or wrong-message payloads and a late result after switching bubbles', async () => {
  const first = deferred<CompanionsResponse>(); const other = { ...scope, companionId: 'sister', messageId: 'sister-reply' };
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async command => 'companionId' in command && command.companionId === 'fish' ? first.promise : { ok: true, replyMemory: receipt() }); const { api } = apiFor(request);
  await mount(<CompanionReplyMemoryDetails scope={scope} api={api} />);
  await act(async () => root!.render(<CompanionReplyMemoryDetails scope={other} api={api} />));
  expect(node!.textContent).toContain('归属未能核实');
  await act(async () => first.resolve({ ok: true, replyMemory: receipt({ contextText: '上一个伙伴的迟到私人正文' }) }));
  expect(node!.textContent).not.toContain('上一个伙伴'); expect(node!.querySelector('[data-reply-memory-context]')).toBeNull();
});

it('distinguishes no injected text, pending capture, degraded recall and historical absence', async () => {
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>().mockResolvedValueOnce({ ok: true, replyMemory: receipt({ contextText: '', contextCharacters: 0, pending: true, degraded: true }) })
    .mockResolvedValueOnce({ ok: true, replyMemory: receipt({ state: 'unavailable', explanation: '这条历史回复没有保存完整的召回凭证。' }) }); const { api } = apiFor(request);
  await mount(<CompanionReplyMemoryDetails scope={scope} api={api} />);
  expect(node!.textContent).toContain('这轮没有注入长期记忆原文'); expect(node!.textContent).toContain('仍在收录或建立索引'); expect(node!.textContent).toContain('召回发生降级');
  expect(node!.querySelector('[data-reply-memory-context]')).toBeNull();
  await act(async () => button('重新核验本轮回忆').click());
  expect(node!.textContent).toContain('历史回复没有保存完整的召回凭证'); expect(node!.querySelector('[data-recall-candidate]')).toBeNull();
});

it('discards current evidence on a failed revalidation and permits a fresh retry', async () => {
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>().mockResolvedValueOnce({ ok: true, replyMemory: receipt() }).mockRejectedValueOnce(new Error('资产库已断开')).mockResolvedValueOnce({ ok: true, replyMemory: receipt({ contextText: '重新核验后的原文' }) }); const { api } = apiFor(request);
  await mount(<CompanionReplyMemoryDetails scope={scope} api={api} />);
  await act(async () => button('重新核验本轮回忆').click()); expect(node!.textContent).toContain('资产库已断开'); expect(node!.querySelector('[data-reply-memory-context]')).toBeNull();
  await act(async () => button('重新核验本轮回忆').click()); expect(node!.querySelector('[data-reply-memory-context]')?.textContent).toBe('重新核验后的原文');
});

it('keeps one pending shell and the open recall details through clock ticks, live stages and delayed history pages', async () => {
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async () => ({ ok: true, replyMemory: receipt() })); const { api, listeners } = apiFor(request);
  Object.defineProperty(window, 'worldlinebox', { configurable: true, value: { companions: api } });
  const store = new CompanionReplyStreamStore(), sourceMessageId = 'source-fish';
  const message: CompanionMessage = { id: scope.messageId, conversationId: scope.conversationId, authorId: scope.companionId, replyToId: sourceMessageId, sequence: 2,
    createdAt: at, kind: 'text', content: '', attachments: [], status: 'sent', isReplyDraft: true, segments: [], replyProgress: { revision: 1, phase: 'context', detail: '正在读取最近对话并核验来源', startedAt: at, updatedAt: at } };
  const render = (value = message, now = Date.parse(at)) => <CompanionMessageBubble message={value} actions={[]} now={now} streamStore={store} interrupted={false}
    onOpenAction={() => undefined} onOpenUrl={() => undefined} onOpenAttachment={() => undefined} onLocateQuote={() => undefined} onStreamLayout={() => undefined} />;
  store.reconcile([message]); await mount(render());
  const shell = node!.querySelector('.companions-reply-thread')!;
  expect(shell.querySelector('[data-reply-placeholder]')).not.toBeNull();
  await act(() => store.accept({ conversationId: scope.conversationId, companionId: scope.companionId, messageId: scope.messageId, sourceMessageId, step: 0, attemptId: 'empty-opening', phase: 'streaming', text: '' }));
  expect(shell.querySelector('.companions-loop-segment, .companions-reply-cursor')).toBeNull();
  const frame = (revision: number, detail: string): CompanionReplyStreamEvent => ({ conversationId: scope.conversationId, companionId: scope.companionId, messageId: scope.messageId,
    sourceMessageId, step: 0, attemptId: 'progress', phase: 'progress', text: '', progress: { ...message.replyProgress!, revision, phase: 'memory', detail, memory: { status: 'running' } } });
  await act(() => store.accept(frame(2, '等待本伙伴的记忆查询')));
  await act(async () => button('展开回复过程').click());
  await act(async () => button('查看这次回复的回忆').click());
  const details = node!.querySelector('[role="dialog"][aria-label="这次回复的回忆"]')!;
  const currentDetails = node!.querySelector('.companions-reply-memory-wait');
  expect(node!.textContent).toContain('这次回忆还在进行'); expect(node!.textContent).not.toContain('历史记录不会补造');
  expect(request).not.toHaveBeenCalled();
  for (let revision = 3; revision < 8; revision++) {
    await act(() => store.accept(frame(revision, revision % 2 ? '核验记忆来源' : '正在检索获权记忆并准备这次召回的完整上下文')));
    await act(async () => { store.reconcile([message]); root!.render(render(message, Date.parse(at) + revision * 1000)); });
    expect(node!.querySelector('.companions-reply-thread')).toBe(shell);
    expect(node!.querySelector('[role="dialog"][aria-label="这次回复的回忆"]')).toBe(details);
    expect(node!.querySelector('.companions-reply-memory-wait')).toBe(currentDetails);
    expect(shell.querySelector('[data-reply-placeholder]')).not.toBeNull();
    expect(node!.querySelector('[data-reply-stage]')?.getAttribute('data-reply-stage')).toBe('memory');
  }
  expect(request).not.toHaveBeenCalled();
  // The real completed receipt replaces only the running status, once available.
  await act(() => store.accept({ ...frame(8, '正在生成回复'), progress: { ...frame(8, '').progress!, phase: 'thinking', memory: { status: 'completed', count: 1, injected: true } } }));
  expect(request).toHaveBeenCalledTimes(1); expect(node!.querySelector('[role="dialog"][aria-label="这次回复的回忆"]')).toBe(details);
  expect(node!.querySelector('[data-reply-memory-context]')?.textContent).toBe(receipt().contextText);
  await act(async () => { const completed = { ...message, isReplyDraft: false, content: '回复正文', segments: [{ text: '回复正文', actionIds: [] }], replyProgress: { ...frame(9, '').progress!, phase: 'completed' as const } }; store.reconcile([completed]); root!.render(render(completed)); });
  expect(shell.querySelector('.companions-message-bubble')!.textContent).toContain('回复正文');
  expect(shell.querySelector('[data-reply-stage]')).toBeNull(); expect(listeners.size).toBe(0);
});

it('labels a not-yet-persisted live receipt as ongoing until the reply finishes', async () => {
  const historicalExplanation = '这条回复没有保存可查看的召回详情。历史记录不会补造召回内容。';
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async () => ({ ok: true, replyMemory: receipt({ state: 'unavailable', explanation: historicalExplanation }) })); const { api } = apiFor(request);
  await mount(<CompanionReplyMemoryDetails scope={scope} api={api} replyRunning />);
  expect(node!.textContent).toContain('记忆上下文尚未完成保存'); expect(node!.textContent).not.toContain(historicalExplanation);
  await act(async () => root!.render(<CompanionReplyMemoryDetails scope={scope} api={api} replyRunning={false} />));
  expect(node!.textContent).toContain(historicalExplanation);
});
