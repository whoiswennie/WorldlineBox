// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionReplyMemory } from '../../src/shared/companion-reply-memory';
import { CompanionReplyProgress } from '../../src/renderer/companions/CompanionReplyProgress';
import { CompanionReplyMemoryDetails, type ReplyMemoryScope } from '../../src/renderer/companions/CompanionReplyMemoryDetails';

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
  await mount(<CompanionReplyProgress scope={scope} now={Date.parse(at)} progress={{ revision: 1, phase: 'completed', detail: '回复已完成', startedAt: at, updatedAt: at, memory: { status: 'completed', count: 1, injected: true } }} />);
  expect(request).not.toHaveBeenCalled(); expect(listeners.size).toBe(0); expect(node!.querySelector('[data-reply-memory-context]')).toBeNull();
  const details = node!.querySelector<HTMLDetailsElement>('.companions-bubble-memory')!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'reply.memory.inspect', ...scope, contextOffset: 0, contextLimit: 8192 }); expect(listeners.size).toBe(1);
  expect(node!.querySelector('[data-reply-memory-context]')?.textContent).toBe(receipt().contextText);
  await act(async () => { details.open = false; details.dispatchEvent(new Event('toggle')); });
  expect(node!.querySelector('[aria-label="本轮回忆详情"]')).toBeNull(); expect(listeners.size).toBe(0);
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); }); expect(request).toHaveBeenCalledTimes(2);
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
